// Scores: pure TypeScript, no LLM. Current vitals, the resident's own baseline, deltas, and NEWS2.
// NEWS2 per Royal College of Physicians 2017, SpO2 scale 1.
import type { Resident } from "./db.js";
import type { ExtractedFacts } from "./types.js";
import { newConfusion } from "./safety/rules.js";

export type VitalKey = "sbp" | "dbp" | "hr" | "rr" | "temp_c" | "spo2";

export type VitalReading = {
  value: number;
  from: "call" | "chart";
  evidence: string; // quote from the call, or the chart reading timestamp
};

export type CurrentVitals = Partial<Record<VitalKey, VitalReading>> & {
  o2: { value: string; onOxygen: boolean; from: "call" | "chart"; evidence: string };
  consciousness: { value: "A" | "C"; from: "call" | "chart"; evidence: string };
};

export type Baseline = Partial<Record<VitalKey, number>> & { n: number; source: string };

export type Delta = { key: VitalKey; label: string; current: number; baseline: number; diff: number; from: "call" | "chart" };

export type News2Part = { param: string; value: string; points: number };
export type News2 = { total: number; parts: News2Part[]; band: "low" | "low-medium" | "medium" | "high"; anyThree: boolean; complete: boolean };

export type Scores = { current: CurrentVitals; baseline: Baseline; deltas: Delta[]; news2: News2 };

function isOxygen(o2: string): boolean {
  const s = o2.toLowerCase();
  if (/\b(ra|room air)\b/.test(s)) return false;
  return /(\d+\s*(l|lpm|liters?))|nasal|cannula|mask|oxygen|o2/.test(s);
}

export function currentVitals(r: Resident, facts: ExtractedFacts | null): CurrentVitals {
  const lastChart = [...r.vitals_history].sort((a, b) => a.ts.localeCompare(b.ts)).at(-1)!;
  const chartTs = new Date(lastChart.ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const out: Partial<CurrentVitals> = {};
  for (const key of ["sbp", "dbp", "hr", "rr", "temp_c", "spo2"] as const) {
    // Latest value stated on the call wins; otherwise fall back to the last charted value, labeled as such.
    const said = [...(facts?.vitals_reported ?? [])].reverse().find((v) => typeof v[key] === "number");
    out[key] = said
      ? { value: said[key] as number, from: "call", evidence: said.quote }
      : { value: lastChart[key], from: "chart", evidence: `charted ${chartTs}` };
  }
  const saidO2 = [...(facts?.vitals_reported ?? [])].reverse().find((v) => typeof v.o2 === "string");
  out.o2 = saidO2
    ? { value: saidO2.o2!, onOxygen: isOxygen(saidO2.o2!), from: "call", evidence: saidO2.quote }
    : { value: lastChart.o2, onOxygen: isOxygen(lastChart.o2), from: "chart", evidence: `charted ${chartTs}` };
  // Consciousness follows the clinical policy in safety/rules.ts (new vs worsening chronic confusion).
  const conf = newConfusion(r, facts);
  out.consciousness = conf
    ? { value: "C", from: "call", evidence: conf.quote }
    : { value: "A", from: "chart", evidence: `charted ${chartTs}` };
  return out as CurrentVitals;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
}

export function baselineOf(r: Resident): Baseline {
  const rows = r.vitals_history;
  const b: Baseline = { n: rows.length, source: `median of ${rows.length} charted readings, last 14 days` };
  for (const key of ["sbp", "dbp", "hr", "rr", "temp_c", "spo2"] as const) b[key] = median(rows.map((v) => v[key]));
  return b;
}

const LABELS: Record<VitalKey, string> = { sbp: "SBP", dbp: "DBP", hr: "HR", rr: "RR", temp_c: "Temp", spo2: "SpO2" };

function deltas(current: CurrentVitals, baseline: Baseline): Delta[] {
  return (["sbp", "hr", "rr", "spo2", "temp_c"] as const).flatMap((key) => {
    const c = current[key];
    const b = baseline[key];
    if (!c || b === undefined) return [];
    return [{ key, label: LABELS[key], current: c.value, baseline: b, diff: Math.round((c.value - b) * 10) / 10, from: c.from }];
  });
}

// ---------- NEWS2 ----------

const band = (pts: number, ranges: [number, number, number][]) => ranges.find(([lo, hi]) => pts >= lo && pts <= hi)?.[2] ?? 0;

export function news2Points(v: { rr: number; spo2: number; onOxygen: boolean; sbp: number; hr: number; consciousness: "A" | "C"; temp_c: number }): News2 {
  const parts: News2Part[] = [
    { param: "Respiration rate", value: `${v.rr}/min`, points: band(v.rr, [[-Infinity, 8, 3], [9, 11, 1], [12, 20, 0], [21, 24, 2], [25, Infinity, 3]]) },
    { param: "SpO2 (scale 1)", value: `${v.spo2}%`, points: band(v.spo2, [[-Infinity, 91, 3], [92, 93, 2], [94, 95, 1], [96, Infinity, 0]]) },
    { param: "Air or oxygen", value: v.onOxygen ? "Oxygen" : "Air", points: v.onOxygen ? 2 : 0 },
    { param: "Systolic BP", value: `${v.sbp}`, points: band(v.sbp, [[-Infinity, 90, 3], [91, 100, 2], [101, 110, 1], [111, 219, 0], [220, Infinity, 3]]) },
    { param: "Pulse", value: `${v.hr}`, points: band(v.hr, [[-Infinity, 40, 3], [41, 50, 1], [51, 90, 0], [91, 110, 1], [111, 130, 2], [131, Infinity, 3]]) },
    { param: "Consciousness", value: v.consciousness === "A" ? "Alert" : "New confusion", points: v.consciousness === "A" ? 0 : 3 },
    // Temperature bands use one decimal place, as charted.
    { param: "Temperature", value: `${v.temp_c.toFixed(1)}°C`, points: band(Math.round(v.temp_c * 10) / 10, [[-Infinity, 35.0, 3], [35.1, 36.0, 1], [36.1, 38.0, 0], [38.1, 39.0, 1], [39.1, Infinity, 2]]) },
  ];
  const total = parts.reduce((s, p) => s + p.points, 0);
  const anyThree = parts.some((p) => p.points === 3);
  const riskBand = total >= 7 ? "high" : total >= 5 ? "medium" : anyThree ? "low-medium" : "low";
  return { total, parts, band: riskBand, anyThree, complete: true };
}

export function computeScores(r: Resident, facts: ExtractedFacts | null): Scores {
  const current = currentVitals(r, facts);
  const baseline = baselineOf(r);
  const news2 = news2Points({
    rr: current.rr!.value, spo2: current.spo2!.value, onOxygen: current.o2.onOxygen,
    sbp: current.sbp!.value, hr: current.hr!.value, consciousness: current.consciousness.value, temp_c: current.temp_c!.value,
  });
  // NEWS2 is only "complete" when every vital came from tonight's call; otherwise some parts use charted values.
  news2.complete = (["rr", "spo2", "sbp", "hr", "temp_c"] as const).every((k) => current[k]!.from === "call");
  return { current, baseline, deltas: deltas(current, baseline), news2 };
}

// Self-check against two hand-worked NEWS2 examples. Run: npx tsx -e "import('./src/scores.ts').then(m=>m.news2SelfCheck())"
export function news2SelfCheck(): boolean {
  const a = news2Points({ rr: 24, spo2: 91, onOxygen: false, sbp: 88, hr: 112, consciousness: "A", temp_c: 37.9 }); // 2+3+0+3+2+0+0 = 10
  const b = news2Points({ rr: 16, spo2: 97, onOxygen: false, sbp: 130, hr: 72, consciousness: "A", temp_c: 36.8 }); // 0
  const ok = a.total === 10 && a.band === "high" && b.total === 0 && b.band === "low";
  console.log(`NEWS2 self-check: ${ok ? "PASS" : "FAIL"} (case A ${a.total} ${a.band}, case B ${b.total} ${b.band})`);
  return ok;
}
