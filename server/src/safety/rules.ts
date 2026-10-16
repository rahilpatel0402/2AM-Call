// SAFETY RULES: deterministic red flags. This file is the heart of the safety story.
//
// - No LLM output can add, remove, or soften a red flag. The only LLM-derived inputs are extracted
//   facts that already passed quote validation in extract.ts (every value is verbatim in the transcript).
// - Red flags never depend on code status or goals of care. A DNR or Do Not Hospitalize order is shown
//   as a neutral note under the flags and never hides or downgrades them.
// - Copy is neutral: "Consider urgent evaluation / transfer. Physician decision." Never a command,
//   never "do not send".
// - Thresholds reviewed by: ______ (physician), date ______.
import type { Resident } from "../db.js";
import type { ExtractedFacts } from "../types.js";
import type { Scores } from "../scores.js";

// ---------- clinical policy ----------

// Does an acute WORSENING of chronic confusion (e.g. dementia, baseline oriented to self only) count as
// "new confusion" for NEWS2 consciousness and the sepsis pattern? RCP NEWS2 scores new confusion as 3.
// false = only confusion in a resident whose baseline is oriented x3 counts (original PLAN.md behavior).
// true  = any reported confusion or worsening counts (more sensitive). Chosen by the physician reviewer.
export const COUNT_WORSENING_OF_CHRONIC_CONFUSION = true;

export const RED_FLAG_BANNER = "Consider urgent evaluation / transfer. Physician decision.";

export type RedFlag = { id: string; title: string; why: string; evidence: string[] };

const ORIENTED_X3 = /oriented\s*(x|times)\s*3|a\s*&?\s*o\s*x\s*3|a&ox3/i;

export function baselineOrientedX3(r: Resident): boolean {
  return ORIENTED_X3.test(r.baseline.mental_status);
}

const CONFUSION = new Set(["new_confusion", "confusion", "worse_confusion", "worsening_confusion", "altered_mental_status", "disorientation", "delirium"]);

// Confusion reported on the call that counts as NEW under the policy above.
export function newConfusion(r: Resident, facts: ExtractedFacts | null): { quote: string } | null {
  const s = facts?.symptoms.find((x) => x.present && CONFUSION.has(x.name));
  if (!s) return null;
  return baselineOrientedX3(r) || COUNT_WORSENING_OF_CHRONIC_CONFUSION ? { quote: s.quote } : null;
}

function symptom(facts: ExtractedFacts | null, names: string[]) {
  return facts?.symptoms.find((s) => s.present && names.includes(s.name)) ?? null;
}

function anticoagulants(r: Resident) {
  return r.medications.filter((m) => m.class === "anticoagulant");
}

const q = (quote: string) => `"${quote}"`;

export function evaluateRules(r: Resident, facts: ExtractedFacts | null, scores: Scores): RedFlag[] {
  const flags: RedFlag[] = [];
  const { current: v, baseline: b, news2 } = scores;
  const src = (x: { from: string; evidence: string }) => (x.from === "call" ? `heard on call: ${q(x.evidence)}` : `last chart value, ${x.evidence}`);

  // hypotension: SBP < 90, or SBP drop >= 40 from baseline
  const sbp = v.sbp!;
  if (sbp.value < 90 || (b.sbp !== undefined && b.sbp - sbp.value >= 40)) {
    flags.push({
      id: "hypotension",
      title: "Hypotension",
      why: sbp.value < 90 ? "Systolic BP below 90." : `Systolic BP ${b.sbp! - sbp.value} below this resident's baseline.`,
      evidence: [`SBP ${sbp.value} (${src(sbp)})`, `Baseline SBP ${b.sbp} (${b.source})`],
    });
  }

  // hypoxia: SpO2 < 90 on current O2, or new O2 requirement
  const spo2 = v.spo2!;
  const chartOnRoomAir = r.vitals_history.every((x) => /^(ra|room air)$/i.test(x.o2));
  if (spo2.value < 90 || (v.o2.onOxygen && v.o2.from === "call" && chartOnRoomAir)) {
    flags.push({
      id: "hypoxia",
      title: "Hypoxia",
      why: spo2.value < 90 ? `SpO2 below 90 on ${v.o2.value}.` : "New oxygen requirement; charted on room air for 14 days.",
      evidence: [`SpO2 ${spo2.value}% (${src(spo2)})`, `Oxygen: ${v.o2.value} (${src(v.o2)})`],
    });
  }

  // tachycardia: HR > 130, or HR > 110 with SBP < 100
  const hr = v.hr!;
  if (hr.value > 130 || (hr.value > 110 && sbp.value < 100)) {
    flags.push({
      id: "tachycardia",
      title: "Tachycardia",
      why: hr.value > 130 ? "Heart rate above 130." : "Heart rate above 110 with systolic BP below 100.",
      evidence: [`HR ${hr.value} (${src(hr)})`, `SBP ${sbp.value} (${src(sbp)})`, `Baseline HR ${b.hr}`],
    });
  }

  // bradycardia: HR < 40
  if (hr.value < 40) {
    flags.push({ id: "bradycardia", title: "Bradycardia", why: "Heart rate below 40.", evidence: [`HR ${hr.value} (${src(hr)})`] });
  }

  // tachypnea: RR >= 25
  const rr = v.rr!;
  if (rr.value >= 25) {
    flags.push({ id: "tachypnea", title: "Tachypnea", why: "Respiratory rate 25 or higher.", evidence: [`RR ${rr.value} (${src(rr)})`, `Baseline RR ${b.rr}`] });
  }

  // sepsis_pattern: temp >= 38.0 AND (SBP < 100 OR RR >= 22 OR new confusion)
  const temp = v.temp_c!;
  const conf = newConfusion(r, facts);
  if (temp.value >= 38.0 && (sbp.value < 100 || rr.value >= 22 || conf)) {
    const ev = [`Temp ${temp.value.toFixed(1)}°C (${src(temp)})`];
    if (sbp.value < 100) ev.push(`SBP ${sbp.value} (${src(sbp)})`);
    if (rr.value >= 22) ev.push(`RR ${rr.value} (${src(rr)})`);
    if (conf) ev.push(`New confusion: ${q(conf.quote)}`);
    flags.push({ id: "sepsis_pattern", title: "Possible sepsis pattern", why: "Fever with low BP, fast breathing, or new confusion.", evidence: ev });
  }

  // fall_anticoag: fall AND (head strike OR unwitnessed) AND on an anticoagulant
  const fall = facts?.events.find((e) => e.type === "fall");
  const headStrike = fall?.head_strike === true || !!symptom(facts, ["head_strike", "head_injury"]);
  const ac = anticoagulants(r);
  if (fall && (headStrike || fall.witnessed === false) && ac.length) {
    flags.push({
      id: "fall_anticoag",
      title: "Fall on anticoagulant",
      why: `${fall.witnessed === false ? "Unwitnessed fall" : "Fall"}${headStrike ? " with head strike" : ""} in a resident on an anticoagulant: risk of intracranial bleeding.`,
      evidence: [`Fall: ${q(fall.quote)}`, ...ac.map((m) => `${m.name} ${m.dose} (medication list)`)],
    });
  }

  // new_confusion_vs_baseline: new or worse confusion when baseline is oriented x3
  const anyConf = symptom(facts, [...CONFUSION]);
  if (anyConf && baselineOrientedX3(r)) {
    flags.push({
      id: "new_confusion_vs_baseline",
      title: "New confusion vs baseline",
      why: "Confusion reported tonight in a resident whose baseline is alert and oriented x3.",
      evidence: [`Tonight: ${q(anyConf.quote)}`, `Baseline: ${r.baseline.mental_status} (${r.baseline.source})`],
    });
  }

  // stroke_signs: focal weakness, facial droop, or new speech change
  const stroke = symptom(facts, ["focal_weakness", "facial_droop", "speech_change", "slurred_speech", "aphasia"]);
  if (stroke) {
    flags.push({ id: "stroke_signs", title: "Possible stroke signs", why: "Focal weakness, facial droop, or new speech change reported.", evidence: [q(stroke.quote)] });
  }

  // chest_pain: chest pain reported
  const cp = symptom(facts, ["chest_pain"]);
  if (cp) {
    flags.push({ id: "chest_pain", title: "Chest pain", why: "Chest pain reported.", evidence: [q(cp.quote)] });
  }

  // news2_high: NEWS2 >= 7, or any single parameter scoring 3
  if (news2.total >= 7 || news2.anyThree) {
    const threes = news2.parts.filter((p) => p.points === 3).map((p) => `${p.param} ${p.value} scores 3`);
    flags.push({
      id: "news2_high",
      title: `NEWS2 ${news2.total}${news2.total >= 7 ? " (high)" : ""}`,
      why: news2.total >= 7 ? "NEWS2 7 or higher." : "A single NEWS2 parameter scores 3.",
      evidence: [...threes, news2.complete ? "All vitals from tonight's call" : "Some parameters use last charted values"],
    });
  }

  return flags;
}

// Neutral goals of care note shown UNDER the flags. Never hides or downgrades them.
export function goalsOfCareNote(r: Resident): string | null {
  const limited = /dnr|dni|do not hospitalize|comfort/i.test(`${r.code_status.value} ${r.code_status.molst}`);
  return limited ? `Goals of care on file: ${r.code_status.value}. MOLST: ${r.code_status.molst}. Red flags are never hidden by goals of care.` : null;
}
