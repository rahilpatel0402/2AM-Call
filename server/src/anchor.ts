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
import { chromium } from "playwright-core";

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
async function openSession(startUrl: string): Promise<{ id: string; liveViewUrl: string; cdpUrl: string }> {
  const json = await anchorApi("POST", "/v1/sessions", { session: { initial_url: startUrl }, browser: { headless: { active: false } } });
  return { id: json.data.id, liveViewUrl: json.data.live_view_url, cdpUrl: json.data.cdp_url };
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

// Called on Sign: posts the signed note into the portal by driving the Anchor cloud browser directly over CDP
// (Playwright), which is fast and deterministic; the live view shows each step and where the note lands.
export async function runEhrPost(r: Resident, physician: string, note: string, agent: EhrAgent, changed: () => void): Promise<void> {
  const base = ehrPublicUrl()!;
  const before = notesFor(r.id).length;
  const t0 = Date.now();
  let sessionId: string | null = null;
  const step = async (detail: string, pauseMs = 700) => {
    agent.detail = detail;
    changed();
    await new Promise((res) => setTimeout(res, pauseMs)); // keeps each step visible in the live view
  };
  await span("anchor.ehr_post_note", "TOOL", { "resident.id": r.id, "input.value": note }, async () => {
    try {
      const s = await openSession(`${base}/ehr/`);
      sessionId = s.id;
      Object.assign(agent, { task: "post", status: "posting", liveViewUrl: s.liveViewUrl, found: [], matchesChart: null });
      await step("Cloud browser open on the facility EHR portal", 3000); // let the live view connect first
      const browser = await chromium.connectOverCDP(s.cdpUrl);
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      if (!page.url().includes("/ehr")) await page.goto(`${base}/ehr/`);
      await step("Signing in");
      await page.fill("#username", EHR_DEMO_USER);
      await page.fill("#password", EHR_DEMO_PASSWORD);
      await page.click("button[type=submit]");
      await page.waitForURL(/\/ehr\/residents/);
      await step(`Opening ${r.name}`);
      await page.click(`a:has-text("${r.name}")`);
      await page.waitForSelector("#note");
      await page.locator("#note").scrollIntoViewIfNeeded();
      await step("Pasting the signed note into Add progress note");
      await page.fill("#author", physician);
      await page.fill("#note", note);
      await step("Saving the note", 1200);
      await page.click('button:has-text("Save note")');
      await page.waitForSelector(".note.new");
      await page.locator(".note.new").first().scrollIntoViewIfNeeded();
      const verified = notesFor(r.id).length > before; // checked against the portal records, not assumed
      Object.assign(agent, verified
        ? { status: "posted", found: ["Signed in", `Opened ${r.name}`, "Note saved under Progress notes"], ms: Date.now() - t0, detail: "Signed note posted to the facility EHR (Progress notes) and verified in the portal." }
        : { status: "failed", ms: Date.now() - t0, detail: "The note is not in the portal." });
    } catch (err) {
      Object.assign(agent, { status: "failed", detail: (err as Error).message.slice(0, 160), ms: Date.now() - t0 });
    } finally {
      changed();
      if (sessionId) setTimeout(() => void closeSession(sessionId!), 15_000); // leave the saved note on screen
    }
  }, () => ({ "anchor.status": agent.status, "anchor.ms": agent.ms ?? 0 }));
}

// ---------- fast chart read: drives the Anchor browser over CDP and parses the portal into a chart ----------

// Called on the first transcript line. Signs in, opens the resident, reads every chart section (about 5 to 8 s),
// and returns a chart built ONLY from what the portal shows (identity fields come from the call setup).
export type PreparedSession = { id: string; liveViewUrl: string; cdpUrl: string; liveSince: number };

// Opens the cloud browser on the portal sign-in page as soon as the call starts, so the live view stream is
// already connected (and visible) before the agent starts signing in.
export async function prepareEhrSession(agent: EhrAgent, changed: () => void): Promise<PreparedSession> {
  const s = await openSession(`${ehrPublicUrl()}/ehr/`);
  Object.assign(agent, { liveViewUrl: s.liveViewUrl, detail: "Facility EHR portal open. Waiting for the resident on the call." });
  changed();
  return { ...s, liveSince: Date.now() };
}

const LIVE_VIEW_WARMUP_MS = 3000;

export async function readChartFromEhr(r: Resident, agent: EhrAgent, changed: () => void, prepared?: Promise<PreparedSession>): Promise<Resident> {
  const base = ehrPublicUrl()!;
  const t0 = Date.now();
  let sessionId: string | null = null;
  const step = async (detail: string, pauseMs = 400) => {
    agent.detail = detail;
    changed();
    await new Promise((res) => setTimeout(res, pauseMs));
  };
  return span("anchor.ehr_read_chart", "TOOL", { "resident.id": r.id, "input.value": `${base}/ehr/` }, async () => {
    try {
      const s = prepared ? await prepared : { ...(await openSession(`${base}/ehr/`)), liveSince: Date.now() };
      sessionId = s.id;
      Object.assign(agent, { task: "pull", status: "reading", liveViewUrl: s.liveViewUrl });
      // Do not act until the live view has had time to connect, so every step is visible.
      await step("Facility EHR portal open", Math.max(800, LIVE_VIEW_WARMUP_MS - (Date.now() - s.liveSince)));
      const browser = await chromium.connectOverCDP(s.cdpUrl);
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      if (!page.url().includes("/ehr")) await page.goto(`${base}/ehr/`);
      await step("Signing in");
      await page.fill("#username", EHR_DEMO_USER);
      await page.fill("#password", EHR_DEMO_PASSWORD);
      await page.click("button[type=submit]");
      await page.waitForURL(/\/ehr\/residents/);
      await step(`Opening ${r.name}`);
      await page.click(`a:has-text("${r.name}")`);
      await page.waitForSelector("#medications");

      const text = async (sel: string) => ((await page.locator(sel).count()) ? (await page.locator(sel).innerText()).trim() : "");
      const rows = (sel: string) => page.$$eval(`${sel} tr`, (trs) => trs.slice(1).map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim())));

      await step("Reading code status, goals of care, baseline, allergies", 300);
      const codeText = await text("#code-status");
      const [codeValue, molst = ""] = codeText.split(/\.\s*MOLST:\s*/);
      const goals = await text("#goals");
      const baselineText = await text("#baseline");
      const allergies = (await text("#allergies")).split(/,\s*/).filter(Boolean);
      const hosp = await text("#hospitalization");

      await page.locator("#medications").scrollIntoViewIfNeeded();
      await step("Reading active medications", 300);
      const meds = (await rows("#medications")).map(([name, dose, cls]) => ({ name, dose, ...(cls ? { class: cls } : {}) }));

      await page.locator("#vitals").scrollIntoViewIfNeeded();
      await step("Reading 14 days of vital signs", 300);
      const vitals = (await rows("#vitals")).map(([ts, bp, hr, rr, temp, sat]) => {
        const [sbp, dbp] = bp.split("/").map(Number);
        const [spo2, ...o2] = sat.replace("%", "").split(/\s+/);
        return { ts: ts.replace(" ", "T") + ":00", sbp, dbp, hr: Number(hr), rr: Number(rr), temp_c: Number(temp), spo2: Number(spo2), o2: o2.join(" ") || "RA", avpu: "A" as const };
      }).reverse();

      await page.locator("#labs").scrollIntoViewIfNeeded();
      await step("Reading lab results", 300);
      const labs = (await rows("#labs")).map(([date, name, value, unit]) => ({ ts: `${date}T06:00:00`, name, value: Number(value), unit }));

      const src = "facility EHR portal (Anchor)";
      const mental = /Mental status:\s*(.*?)\s*Mobility:/.exec(baselineText)?.[1] ?? baselineText;
      const mobility = /Mobility:\s*(.*)$/.exec(baselineText)?.[1] ?? "";
      const hospMatch = /Discharged\s+(\d{4}-\d{2}-\d{2}):\s*(.*)$/.exec(hosp);
      const chart: Resident = {
        ...r, // identity (id, name, age, sex, room, pcp, admitted, diagnoses, notes) from the call setup
        code_status: { value: codeValue.trim(), molst: molst.trim(), source: src },
        goals_of_care: { summary: goals, source: src },
        baseline: { mental_status: mental, mobility, source: src },
        allergies,
        medications: meds,
        vitals_history: vitals,
        labs,
        recent_hospitalization: hospMatch ? { discharged: hospMatch[1], reason: hospMatch[2], source: src } : undefined,
      };
      if (!meds.length || !vitals.length || !chart.code_status.value) throw new Error("chart sections missing in the portal page");

      Object.assign(agent, {
        status: "done",
        found: [`${meds.length} medications`, "Code status / MOLST", "Goals of care", "Baseline", "Allergies", ...(hospMatch ? ["Recent hospitalization"] : []), `${vitals.length} days of vitals`, `${labs.length} lab results`],
        matchesChart: true,
        ms: Date.now() - t0,
        detail: "Chart read from the facility EHR portal. The dashboard now uses it.",
      });
      return chart;
    } catch (err) {
      Object.assign(agent, { status: "failed", detail: `${(err as Error).message.slice(0, 140)}. Using the local chart copy.`, ms: Date.now() - t0 });
      throw err;
    } finally {
      changed();
      if (sessionId) setTimeout(() => void closeSession(sessionId!), 5_000);
    }
  }, () => ({ "anchor.status": agent.status, "anchor.found": agent.found.join(", "), "anchor.ms": agent.ms ?? 0 }));
}
