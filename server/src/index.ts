import "./instrumentation.js"; // first: tracing must patch the AWS SDK before any client exists
import express from "express";
import cors from "cors";
import { env } from "./env.js";
import { getFacilityForResident, getResident, getScript, listResidents } from "./db.js";
import { lineAudio, prewarmAll, sayAudio } from "./tts.js";
import { closingLines } from "./closing.js";
import { askChart } from "./ask.js";
import { draftNote, memorySummary, type Disposition } from "./note.js";
import { rememberCall, resetDemoMemory } from "./memory.js";
import { mockEhrRouter } from "./mockEhr.js";
import { anchorReady, pullChart, runEhrPost, type EhrAgent } from "./anchor.js";
import { recallForResident, seedMemory } from "./memory.js";
import { addSegment, broadcast, createCall, endCall, getCall, replay, setReplaying, subscribe, type CallState, type Speaker } from "./calls.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Mock facility EHR portal (synthetic), reached by Anchor through the public tunnel.
app.use("/ehr", mockEhrRouter());

app.get("/api/anchor/status", (_req, res) => res.json(anchorReady()));

// Anchor Browser signs into the facility web portal and pulls meds, MOLST, allergies (validated against the chart).
app.post("/api/residents/:id/ehr-pull", async (req, res) => {
  const r = getResident(req.params.id);
  if (!r) return res.status(404).json({ error: "resident not found" });
  const ready = anchorReady();
  if (!ready.ok) return res.status(503).json({ error: ready.reason });
  try {
    res.json(await pullChart(r));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, llmProvider: env("LLM_PROVIDER") || "bedrock" });
});

// ---------- Residents ----------

app.get("/api/residents", (_req, res) => {
  res.json(listResidents().map(({ id, name, age, sex, room }) => ({ id, name, age, sex, room })));
});

app.get("/api/residents/:id", (req, res) => {
  const r = getResident(req.params.id);
  if (!r) return res.status(404).json({ error: "resident not found" });
  res.json({ resident: r, facility: getFacilityForResident(r.id) });
});

app.get("/api/residents/:id/memory", async (req, res) => {
  if (!getResident(req.params.id)) return res.status(404).json({ error: "resident not found" });
  res.json(await recallForResident(req.params.id));
});

// Demo reset: hide calls signed during rehearsal so prior-call counts start from the seeded history.
app.post("/api/demo/reset", (_req, res) => {
  resetDemoMemory();
  res.json({ ok: true, message: "Signed rehearsal calls hidden; seeded prior calls remain." });
});

// Ask the chart: model-written code runs only in a disposable Daytona sandbox.
app.post("/api/residents/:id/ask", async (req, res) => {
  const r = getResident(req.params.id);
  if (!r) return res.status(404).json({ error: "resident not found" });
  const question = String(req.body?.question ?? "").trim().slice(0, 300);
  if (!question) return res.status(400).json({ error: "question is required" });
  res.json(await askChart(r, question));
});

// ---------- ElevenLabs single-use token for Scribe v2 Realtime ----------

app.get("/api/scribe-token", async (_req, res) => {
  if (!env("ELEVENLABS_API_KEY")) return res.status(500).json({ error: "ELEVENLABS_API_KEY is not set" });
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", {
      method: "POST",
      headers: { "xi-api-key": env("ELEVENLABS_API_KEY") },
    });
    if (!r.ok) return res.status(502).json({ error: `ElevenLabs HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` });
    const { token } = (await r.json()) as { token: string };
    res.json({ token });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// ---------- Voiced replay (ElevenLabs Text to Speech) ----------

app.get("/api/scripts/:name", (req, res) => {
  const lines = getScript(req.params.name);
  if (!lines) return res.status(404).json({ error: "unknown script" });
  res.json(lines);
});

app.get("/api/tts/:script/:index", async (req, res) => {
  try {
    const audio = await lineAudio(req.params.script, Number(req.params.index));
    res.set({ "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" }).send(audio);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/tts-say", async (req, res) => {
  const script = String(req.query.script ?? "");
  const speaker = req.query.speaker === "nurse" ? "nurse" : "doctor";
  const text = String(req.query.text ?? "").slice(0, 400);
  if (!text) return res.status(400).json({ error: "text is required" });
  try {
    res.set({ "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" }).send(await sayAudio(script, speaker, text));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// ---------- Calls ----------

function withCall(id: string, res: express.Response): CallState | undefined {
  const state = getCall(id);
  if (!state) res.status(404).json({ error: "call not found" });
  return state;
}

app.post("/api/calls", (req, res) => {
  const residentId = String(req.body?.residentId ?? "");
  const resident = getResident(residentId);
  if (!resident) return res.status(400).json({ error: "unknown residentId" });
  const state = createCall(residentId);
  // At call start, Anchor's agent signs into the facility EHR portal and reads the chart (watched via live view).
  state.wantsEhr = !!req.body?.ehrAgent && anchorReady().ok;
  res.json(state);
});

app.get("/api/calls/:id/stream", (req, res) => {
  const state = withCall(req.params.id, res);
  if (state) subscribe(state, res);
});

app.post("/api/calls/:id/segments", (req, res) => {
  const state = withCall(req.params.id, res);
  if (!state) return;
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "text is required" });
  const speaker: Speaker = ["nurse", "doctor"].includes(req.body?.speaker) ? req.body.speaker : "unknown";
  res.json(addSegment(state, text, speaker));
});

app.post("/api/calls/:id/replay", (req, res) => {
  const state = withCall(req.params.id, res);
  if (!state) return;
  const script = String(req.body?.script ?? state.residentId.replace("res_", ""));
  replay(state, script).catch((err) => console.error(`[replay] ${err.message}`));
  res.json({ ok: true, script });
});

// Client-driven voiced replay marks the call as a replay (scenario clock, "Replay of recorded call").
app.post("/api/calls/:id/replaying", (req, res) => {
  const state = withCall(req.params.id, res);
  if (!state) return;
  setReplaying(state, req.body?.on !== false);
  res.json({ ok: true });
});

// Physician picks the disposition; Claude drafts the note from the call record only.
app.post("/api/calls/:id/note", async (req, res) => {
  const state = withCall(req.params.id, res);
  if (!state) return;
  const disposition = req.body?.disposition as Disposition;
  if (disposition !== "transfer" && disposition !== "treat_in_place") return res.status(400).json({ error: "disposition must be transfer or treat_in_place" });
  try {
    state.disposition = disposition;
    state.note = await draftNote(state, disposition);
    broadcast(state);
    res.json({ note: state.note });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Sign: the physician-edited note is saved and the call is remembered in SurrealDB Agent Memory.
app.post("/api/calls/:id/sign", async (req, res) => {
  const state = withCall(req.params.id, res);
  if (!state) return;
  const physician = String(req.body?.physician ?? "").trim() || "On-call physician";
  const note = String(req.body?.note ?? state.note ?? "").replace(/Reviewed and signed by: _+/, `Reviewed and signed by: ${physician}`);
  if (!state.disposition) return res.status(400).json({ error: "choose a disposition first" });
  state.note = note;
  state.signedBy = physician;
  const m = memorySummary(state, state.disposition, physician, note);
  try {
    await rememberCall({ id: state.callId, residentId: state.residentId, ts: new Date(state.clockStart).toLocaleString("sv-SE").replace(" ", "T").slice(0, 16), physician, ...m }); // ts in local facility time
  } catch (err) {
    console.warn(`[sign] memory write failed: ${(err as Error).message}`);
  }
  // Post the signed note into the facility EHR portal in the background (Anchor Browser).
  if (anchorReady().ok) {
    const agent: EhrAgent = { status: "starting", task: "post", liveViewUrl: null, detail: "Opening a cloud browser for the facility EHR portal", found: [], matchesChart: null, ms: null };
    state.ehrAgent = agent;
    state.ehrPost = { status: "posting", detail: "Anchor is signing into the facility EHR portal" };
    const changed = () => {
      if (agent.status === "posted") state.ehrPost = { status: "posted", detail: `Posted and verified in the facility portal (${Math.round((agent.ms ?? 0) / 1000)} s)` };
      if (agent.status === "failed") state.ehrPost = { status: "failed", detail: agent.detail };
      broadcast(state);
    };
    void runEhrPost(getResident(state.residentId)!, physician, note, agent, changed);
  }
  broadcast(state);
  res.json({ ok: true, remembered: m });
});

// The physician tells the nurse the decision before hanging up.
app.get("/api/calls/:id/closing", (req, res) => {
  const state = withCall(req.params.id, res);
  if (!state) return;
  const d = req.query.disposition === "transfer" ? "transfer" : "treat_in_place";
  res.json(closingLines(getResident(state.residentId)!, state.residentId.replace("res_", ""), d));
});

app.post("/api/calls/:id/end", (req, res) => {
  const state = withCall(req.params.id, res);
  if (!state) return;
  endCall(state);
  res.json({ ok: true });
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT}`);
  void seedMemory();
  void prewarmAll();
});
