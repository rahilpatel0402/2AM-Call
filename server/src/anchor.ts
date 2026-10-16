// Anchor Browser: a cloud browser agent signs into the facility's web EHR portal (no API available to the
// on-call group), pulls the chart essentials, and posts the signed on-call note back.
// API: POST https://api.anchorbrowser.io/v1/tools/perform-web-task { url, prompt, output_schema, secret_values }.
// Demo targets only the synthetic mock portal in mockEhr.ts, exposed publicly by `npm run tunnel`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";
import type { Resident } from "./db.js";
import { EHR_DEMO_PASSWORD, EHR_DEMO_USER, notesFor } from "./mockEhr.js";
import { span } from "./tracing.js";

const URL_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.ehr-url");

export function ehrPublicUrl(): string | null {
  const fromEnv = env("EHR_PUBLIC_URL");
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  return fs.existsSync(URL_FILE) ? fs.readFileSync(URL_FILE, "utf8").trim().replace(/\/+$/, "") || null : null;
}

export function anchorReady(): { ok: boolean; reason?: string } {
  if (!env("ANCHOR_API_KEY")) return { ok: false, reason: "ANCHOR_API_KEY is not set" };
  if (!ehrPublicUrl()) return { ok: false, reason: "EHR portal tunnel is not running (npm run tunnel)" };
  return { ok: true };
}

const SIGN_IN = "Sign in with the username EHR_USERNAME and the password EHR_PASSWORD (both provided as secret values).";

async function performWebTask(body: Record<string, unknown>, sessionId?: string): Promise<any> {
  const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  const res = await fetch(`https://api.anchorbrowser.io/v1/tools/perform-web-task${qs}`, {
    method: "POST",
    headers: { "anchor-api-key": env("ANCHOR_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, secret_values: { EHR_USERNAME: EHR_DEMO_USER, EHR_PASSWORD: EHR_DEMO_PASSWORD } }),
    signal: AbortSignal.timeout(240_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anchor HTTP ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  const result = json?.data?.result?.result ?? json?.data?.result;
  return typeof result === "string" ? tryJson(result) : result;
}

function tryJson(s: string): any {
  try {
    return JSON.parse(s.replace(/^```(json)?|```$/g, "").trim());
  } catch {
    return s;
  }
}

export type PulledChart = {
  medications: { name: string; dose: string }[];
  code_status: string;
  allergies: string;
  pulledAt: string;
  ms: number;
  matchesChart: { medications: boolean; codeStatus: boolean; allergies: boolean };
};

const PULL_SCHEMA = {
  type: "object",
  properties: {
    medications: { type: "array", items: { type: "object", properties: { name: { type: "string" }, dose: { type: "string" } }, required: ["name", "dose"] } },
    code_status: { type: "string" },
    allergies: { type: "string" },
  },
  required: ["medications", "code_status", "allergies"],
};

export async function pullChart(r: Resident): Promise<PulledChart> {
  const base = ehrPublicUrl()!;
  return span("anchor.pull_chart", "TOOL", { "resident.id": r.id, "input.value": `${base}/ehr/` }, async () => {
    const t0 = Date.now();
    const out = await performWebTask({
      url: `${base}/ehr/`,
      prompt: `${SIGN_IN} Open the census, open the resident named "${r.name}", and extract exactly as shown on the page: every row of the Active medications table (medication name and dose), the Code status / MOLST text, and the Allergies text. Return JSON only.`,
      output_schema: PULL_SCHEMA,
      max_steps: 25,
    });
    if (!out || !Array.isArray(out.medications) || typeof out.code_status !== "string") throw new Error(`unexpected Anchor result: ${JSON.stringify(out).slice(0, 200)}`);
    // Validate the scraped data against our chart before showing it as a source.
    const names = (xs: { name: string }[]) => xs.map((m) => m.name.toLowerCase().trim()).sort().join("|");
    const matches = {
      medications: names(out.medications) === names(r.medications),
      codeStatus: out.code_status.toLowerCase().includes(r.code_status.value.toLowerCase().split("/")[0]),
      allergies: r.allergies.every((a) => String(out.allergies).toLowerCase().includes(a.toLowerCase().split(" (")[0])),
    };
    return {
      medications: out.medications.map((m: any) => ({ name: String(m.name), dose: String(m.dose) })),
      code_status: out.code_status,
      allergies: String(out.allergies),
      pulledAt: new Date().toISOString(),
      ms: Date.now() - t0,
      matchesChart: matches,
    };
  }, (p) => ({ "output.value": JSON.stringify(p) }));
}

export async function postNote(r: Resident, physician: string, note: string): Promise<{ verified: boolean; ms: number }> {
  const base = ehrPublicUrl()!;
  const before = notesFor(r.id).length;
  return span("anchor.post_note", "TOOL", { "resident.id": r.id, "input.value": note }, async () => {
    const t0 = Date.now();
    await performWebTask({
      url: `${base}/ehr/`,
      prompt: `${SIGN_IN} Open the census, open the resident named "${r.name}". In the "Add progress note" form, type "${physician}" into the Author field, then type the following text into the Note field exactly, preserving line breaks, and click "Save note". Note text:\n\n${note}`,
      max_steps: 30,
    });
    // Verified against the portal's own records, not the agent's claim.
    const verified = notesFor(r.id).length > before;
    if (!verified) throw new Error("Anchor finished but no new note is in the portal");
    return { verified, ms: Date.now() - t0 };
  }, (x) => ({ "anchor.verified": x.verified, "anchor.ms": x.ms }));
}

// ---------- live EHR agent: runs at call start, watched in a picture-in-picture live view ----------

export type EhrAgent = {
  status: "starting" | "reading" | "posting" | "done" | "posted" | "failed";
  task: "pull" | "post";
  liveViewUrl: string | null;
  detail: string;
  found: string[];          // what the agent extracted, shown as checkmarks
  matchesChart: boolean | null;
  ms: number | null;
};

async function anchorApi(method: string, pathname: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.anchorbrowser.io${pathname}`, {
    method,
    headers: { "anchor-api-key": env("ANCHOR_API_KEY"), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anchor ${method} ${pathname} HTTP ${res.status}: ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : {};
}

// Headful cloud browser opened on the portal sign-in page; live_view_url is embeddable in an iframe.
async function openSession(startUrl: string): Promise<{ id: string; liveViewUrl: string }> {
  const json = await anchorApi("POST", "/v1/sessions", { session: { initial_url: startUrl }, browser: { headless: { active: false } } });
  return { id: json.data.id, liveViewUrl: json.data.live_view_url };
}

async function closeSession(id: string) {
  await anchorApi("DELETE", `/v1/sessions/${id}`).catch(() => {});
}

const FULL_PULL_SCHEMA = {
  type: "object",
  properties: {
    code_status: { type: "string" },
    goals_of_care: { type: "string" },
    baseline_mental_status: { type: "string" },
    allergies: { type: "string" },
    medications: { type: "array", items: { type: "object", properties: { name: { type: "string" }, dose: { type: "string" } }, required: ["name", "dose"] } },
    recent_hospitalization: { type: "string" },
    vitals: { type: "array", items: { type: "object", properties: { date: { type: "string" }, bp: { type: "string" }, hr: { type: "number" }, temp_c: { type: "number" }, spo2: { type: "string" } } } },
    labs: { type: "array", items: { type: "object", properties: { date: { type: "string" }, test: { type: "string" }, value: { type: "number" } } } },
  },
  required: ["code_status", "medications", "allergies", "vitals", "labs"],
};

// Called at call start. Updates `agent` in place and calls `changed()` so the UI live view and status update.
export async function runEhrPull(r: Resident, agent: EhrAgent, changed: () => void): Promise<void> {
  const base = ehrPublicUrl()!;
  const t0 = Date.now();
  let sessionId: string | null = null;
  await span("anchor.ehr_agent_pull", "TOOL", { "resident.id": r.id, "input.value": `${base}/ehr/` }, async () => {
    try {
      const s = await openSession(`${base}/ehr/`);
      sessionId = s.id;
      Object.assign(agent, { status: "reading", liveViewUrl: s.liveViewUrl, detail: "Signing in to the facility EHR portal and reading the chart" });
      changed();
      const out = await performWebTask({
        prompt: `${SIGN_IN} Open the census, then open the resident named "${r.name}". From that resident's page extract, exactly as shown: Code status / MOLST, Goals of care, Baseline mental status, Allergies, every Active medication (name and dose), Recent hospitalization if present, the 5 most recent Vital signs rows, and every Lab results row. Return JSON only.`,
        output_schema: FULL_PULL_SCHEMA,
        max_steps: 25,
      }, s.id);
      if (!out || !Array.isArray(out.medications)) throw new Error("unexpected result from the EHR agent");
      const names = (xs: { name: string }[]) => xs.map((m) => m.name.toLowerCase().trim()).sort().join("|");
      const matches = names(out.medications) === names(r.medications) && String(out.code_status).toLowerCase().includes(r.code_status.value.toLowerCase().split("/")[0]);
      const found = [
        `${out.medications.length} medications`,
        "Code status / MOLST",
        out.goals_of_care ? "Goals of care" : null,
        out.baseline_mental_status ? "Baseline mental status" : null,
        "Allergies",
        out.recent_hospitalization ? "Recent hospitalization" : null,
        `${(out.vitals ?? []).length} recent vital sign rows`,
        `${(out.labs ?? []).length} lab results`,
      ].filter(Boolean) as string[];
      Object.assign(agent, {
        status: "done", found, matchesChart: matches, ms: Date.now() - t0,
        detail: matches ? "Chart read from the facility EHR portal. Matches the chart shown on this dashboard." : "Chart read from the facility EHR portal. Differences found: review.",
      });
    } catch (err) {
      Object.assign(agent, { status: "failed", detail: (err as Error).message.slice(0, 160), ms: Date.now() - t0 });
    } finally {
      changed();
      if (sessionId) setTimeout(() => void closeSession(sessionId!), 8_000); // leave the final page visible briefly
    }
  }, () => ({ "anchor.status": agent.status, "anchor.found": agent.found.join(", "), "anchor.matches_chart": String(agent.matchesChart), "anchor.ms": agent.ms ?? 0 }));
}

// Called on Sign: the agent posts the signed note into the portal, watched in the same live view window.
export async function runEhrPost(r: Resident, physician: string, note: string, agent: EhrAgent, changed: () => void): Promise<void> {
  const base = ehrPublicUrl()!;
  const before = notesFor(r.id).length;
  const t0 = Date.now();
  let sessionId: string | null = null;
  await span("anchor.ehr_agent_post", "TOOL", { "resident.id": r.id, "input.value": note }, async () => {
    try {
      const s = await openSession(`${base}/ehr/`);
      sessionId = s.id;
      Object.assign(agent, { task: "post", status: "posting", liveViewUrl: s.liveViewUrl, found: [], matchesChart: null, detail: "Signing in to the facility EHR portal to post the signed note" });
      changed();
      await performWebTask({
        prompt: `${SIGN_IN} Open the census, open the resident named "${r.name}". In the "Add progress note" form, type "${physician}" into the Author field, then type the following text into the Note field exactly, preserving line breaks, and click "Save note". Note text:\n\n${note}`,
        max_steps: 30,
      }, s.id);
      const verified = notesFor(r.id).length > before; // checked against the portal's own records
      Object.assign(agent, verified
        ? { status: "posted", ms: Date.now() - t0, detail: "Signed note posted to the facility EHR and verified in the portal." }
        : { status: "failed", ms: Date.now() - t0, detail: "Agent finished but the note is not in the portal." });
    } catch (err) {
      Object.assign(agent, { status: "failed", detail: (err as Error).message.slice(0, 160), ms: Date.now() - t0 });
    } finally {
      changed();
      if (sessionId) setTimeout(() => void closeSession(sessionId!), 8_000);
    }
  }, () => ({ "anchor.status": agent.status, "anchor.ms": agent.ms ?? 0 }));
}
