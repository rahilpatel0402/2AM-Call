import "./instrumentation.js"; // first: tracing must patch the AWS SDK before any client exists
import express from "express";
import cors from "cors";
import { env } from "./env.js";
import { getFacilityForResident, getResident, getScript, listResidents } from "./db.js";
import { lineAudio, prewarmAll } from "./tts.js";
import { recallForResident, seedMemory } from "./memory.js";
import { addSegment, createCall, endCall, getCall, replay, setReplaying, subscribe, type CallState, type Speaker } from "./calls.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

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

// ---------- Calls ----------

function withCall(id: string, res: express.Response): CallState | undefined {
  const state = getCall(id);
  if (!state) res.status(404).json({ error: "call not found" });
  return state;
}

app.post("/api/calls", (req, res) => {
  const residentId = String(req.body?.residentId ?? "");
  if (!getResident(residentId)) return res.status(400).json({ error: "unknown residentId" });
  res.json(createCall(residentId));
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
