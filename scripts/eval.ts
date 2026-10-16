// Eval suite: runs scripted calls through the real pipeline (no UI) and checks safety expectations.
// Each case runs RUNS times (LLM variability). Results print as a table and are logged to Arize as eval spans.
// Run from the repo root: npm run eval
import "../server/src/instrumentation.js";
import { flushTraces } from "../server/src/instrumentation.js";
import { getResident, getScript, seedPriorCalls, type ScriptLine } from "../server/src/db.js";
import { extractFacts } from "../server/src/extract.js";
import { computeScores } from "../server/src/scores.js";
import { evaluateRules } from "../server/src/safety/rules.js";
import { computeCovered, computeUnsaid } from "../server/src/unsaid.js";
import { inSession, span } from "../server/src/tracing.js";

const RUNS = Number(process.env.EVAL_RUNS ?? 3);

type Case = {
  name: string;
  about: string;
  resident: string;
  lines: ScriptLine[];
  mustFlag?: string[];
  mustNotFlag?: string[];
  mustSurface?: string[];
  mustNotSurface?: string[];
  mustCover?: string[];
  tempC?: number;
};

const L = (speaker: "nurse" | "doctor", text: string): ScriptLine => ({ speaker, text, delayMs: 0 });
const ALL_CRITICAL = ["fall_anticoag", "hypotension", "hypoxia", "tachycardia", "sepsis_pattern", "qsofa", "acute_mental_status_change", "stroke_signs", "chest_pain", "news2_high"];

const CASES: Case[] = [
  {
    name: "margaret", about: "Unwitnessed fall, head strike, on apixaban; nurse omits anticoagulant and baseline",
    resident: "res_margaret", lines: getScript("margaret")!,
    mustFlag: ["fall_anticoag", "acute_mental_status_change"], mustSurface: ["anticoagulation", "baseline_mental_status"],
  },
  {
    name: "joseph", about: "Fever + worse confusion in dementia; MOLST Do Not Hospitalize and prior calls unsaid",
    resident: "res_joseph", lines: getScript("joseph")!,
    mustFlag: ["sepsis_pattern", "acute_mental_status_change"], mustNotFlag: ["hypotension", "fall_anticoag"],
    mustSurface: ["code_status", "goals_of_care", "prior_calls"],
  },
  {
    name: "dorothy", about: "Nurse downplays shock: 'BP a little low' is 88/52, HR 112, 37.9 C",
    resident: "res_dorothy", lines: getScript("dorothy")!,
    mustFlag: ["hypotension", "tachycardia", "sepsis_pattern", "qsofa", "news2_high"], mustSurface: ["recent_hospitalization", "glucose_check"],
  },
  {
    name: "clean_call", about: "Routine call, normal vitals: no false alarms",
    resident: "res_margaret",
    lines: [
      L("nurse", "Hi Doctor, Linda from Bayview, calling about Margaret Ellis in 212A. Nothing urgent."),
      L("nurse", "She's asking for something stronger for her knee pain tonight."),
      L("doctor", "Any fall or injury?"),
      L("nurse", "No fall, she's been in bed all evening. She's her usual self, alert and chatting."),
      L("doctor", "Vitals?"),
      L("nurse", "BP 134 over 76, heart rate 70, respirations 16, temp 36.7, sat 97 percent on room air."),
    ],
    mustFlag: [], mustNotFlag: ALL_CRITICAL,
  },
  {
    name: "nurse_says_it_all", about: "Nurse states anticoagulant, code status, and baseline: covered, not surfaced",
    resident: "res_margaret",
    lines: [
      L("nurse", "Margaret Ellis in 212A had an unwitnessed fall about an hour ago and has a bump on her forehead."),
      L("nurse", "She's on Eliquis 5 twice a day, she's a full code, and at baseline she's alert and oriented times three."),
      L("nurse", "Right now she's a little confused about the time."),
      L("nurse", "BP 140 over 82, heart rate 76, respirations 18, temp 36.8, sat 96 percent on room air."),
    ],
    mustFlag: ["fall_anticoag", "acute_mental_status_change"], mustCover: ["anticoagulation", "code_status", "baseline_mental_status"],
    mustNotSurface: ["anticoagulation", "code_status", "baseline_mental_status"],
  },
  {
    name: "fahrenheit", about: "Temperature stated in Fahrenheit (101.2 F) is converted in code",
    resident: "res_joseph",
    lines: [
      L("nurse", "Joseph Ramirez in 118B has a temp of 101.2 Fahrenheit."),
      L("nurse", "He's more confused than usual tonight."),
      L("nurse", "BP 126 over 72, pulse 90, respirations 18, sat 95 percent on room air."),
    ],
    mustFlag: ["sepsis_pattern"], tempC: 38.4,
  },
  {
    name: "uncertain_anticoag", about: "Nurse unsure about a blood thinner: must NOT count as mentioned",
    resident: "res_margaret",
    lines: [
      L("nurse", "Margaret Ellis fell, nobody saw it, and she has a bump on her head."),
      L("nurse", "I'm not sure if she's on a blood thinner, I'd have to look it up."),
      L("nurse", "BP 138 over 80, heart rate 74, respirations 16, temp 36.7, sat 97 percent on room air."),
    ],
    mustFlag: ["fall_anticoag"], mustSurface: ["anticoagulation"],
  },
  {
    name: "new_oxygen", about: "New oxygen requirement with SpO2 89",
    resident: "res_dorothy",
    lines: [
      L("nurse", "Dorothy Kim is short of breath, we put her on 2 liters nasal cannula."),
      L("nurse", "Her sat is 89 percent on the 2 liters, respirations 22, heart rate 96, BP 128 over 70, temp 37.2."),
    ],
    mustFlag: ["hypoxia"],
  },
  {
    name: "stroke_signs", about: "New focal weakness and slurred speech",
    resident: "res_margaret",
    lines: [
      L("nurse", "Margaret Ellis has new weakness in her right arm and her speech is slurred since about midnight."),
      L("nurse", "BP 168 over 92, heart rate 80, respirations 18, temp 36.8, sat 96 percent on room air."),
    ],
    mustFlag: ["stroke_signs"],
  },
];

type RunResult = { pass: boolean; fired: string[]; surfaced: string[]; covered: string[]; dropped: number; problems: string[]; ms: number };

async function runCase(c: Case, run: number): Promise<RunResult> {
  const r = getResident(c.resident)!;
  const segments = c.lines.map((l, i) => ({ id: String(i), ts: i, speaker: l.speaker, text: l.text }));
  const priorCalls = seedPriorCalls.filter((p) => p.residentId === r.id).map((p) => ({ ts: p.ts, text: p.summary, source: "seed", backend: "local" }));
  const t0 = Date.now();
  return inSession(`eval-${c.name}-${run}`, () =>
    span("eval.case", "EVALUATOR", { "eval.case": c.name, "eval.run": run, "input.value": c.about }, async () => {
      const facts = await extractFacts(segments);
      const scores = computeScores(r, facts);
      const fired = evaluateRules(r, facts, scores).map((f) => f.id);
      const surfaced = computeUnsaid(r, facts, priorCalls, segments.map((s) => s.text).join(" ")).map((u) => u.item);
      const covered = computeCovered(facts).map((x) => x.item);
      const problems: string[] = [];
      for (const f of c.mustFlag ?? []) if (!fired.includes(f)) problems.push(`missing flag ${f}`);
      for (const f of c.mustNotFlag ?? []) if (fired.includes(f)) problems.push(`unexpected flag ${f}`);
      for (const s of c.mustSurface ?? []) if (!surfaced.includes(s)) problems.push(`not surfaced ${s}`);
      for (const s of c.mustNotSurface ?? []) if (surfaced.includes(s)) problems.push(`surfaced but was said ${s}`);
      for (const s of c.mustCover ?? []) if (!covered.includes(s)) problems.push(`not covered ${s}`);
      if (c.tempC !== undefined && Math.abs((scores.current.temp_c?.value ?? 0) - c.tempC) > 0.15) problems.push(`temp ${scores.current.temp_c?.value} != ${c.tempC}`);
      return { pass: problems.length === 0, fired, surfaced, covered, dropped: facts.dropped.length, problems, ms: Date.now() - t0 };
    }, (res) => ({
      "eval.pass": res.pass, "eval.fired": res.fired.join(","), "eval.expected": (c.mustFlag ?? []).join(","),
      "eval.problems": res.problems.join("; "), "eval.dropped_quotes": res.dropped, "output.value": res.pass ? "PASS" : `FAIL: ${res.problems.join("; ")}`,
    })),
  );
}

// Limited concurrency keeps Bedrock latency stable.
async function pool<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < jobs.length) {
      const k = i++;
      out[k] = await jobs[k]();
    }
  }));
  return out;
}

const jobs = CASES.flatMap((c) => Array.from({ length: RUNS }, (_, run) => () => runCase(c, run + 1).then((res) => ({ c, res }))));
console.log(`Running ${CASES.length} cases x ${RUNS} runs = ${jobs.length} pipeline runs...\n`);
const results = await pool(jobs, 4);

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
console.log(`${pad("CASE", 20)}${pad("EXPECTED FLAGS", 46)}${pad("FIRED (run 1)", 52)}${pad("DROPPED", 9)}RESULT`);
console.log("-".repeat(136));
let passed = 0;
let dropped = 0;
for (const c of CASES) {
  const runs = results.filter((x) => x.c === c).map((x) => x.res);
  const ok = runs.filter((r) => r.pass).length;
  passed += ok;
  dropped += runs.reduce((s, r) => s + r.dropped, 0);
  const expected = (c.mustFlag?.length ? c.mustFlag.join(", ") : "none") + (c.mustNotFlag?.length === ALL_CRITICAL.length ? " (no critical flags)" : "");
  console.log(`${pad(c.name, 20)}${pad(expected, 46)}${pad(runs[0].fired.join(", ") || "none", 52)}${pad(String(runs.reduce((s, r) => s + r.dropped, 0)), 9)}${ok === runs.length ? "PASS" : "FAIL"} ${ok}/${runs.length}`);
  for (const r of runs) for (const p of r.problems) console.log(`${" ".repeat(20)}  ! ${p}`);
}
console.log("-".repeat(136));
console.log(`Pass rate: ${passed}/${results.length} runs (${Math.round((passed / results.length) * 100)}%)  ·  Unverified quotes dropped by the validator: ${dropped}`);
await flushTraces();
process.exit(passed === results.length ? 0 : 1);
