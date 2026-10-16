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

async function performWebTask(body: Record<string, unknown>): Promise<any> {
  const res = await fetch("https://api.anchorbrowser.io/v1/tools/perform-web-task", {
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
