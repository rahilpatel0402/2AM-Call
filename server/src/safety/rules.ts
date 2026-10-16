// SAFETY RULES: deterministic red flags. This file is the heart of the safety story.
//
// - No LLM output can add, remove, or soften a red flag. The only LLM-derived inputs are extracted
//   facts that already passed quote validation in extract.ts (every value is verbatim in the transcript).
// - Red flags never depend on code status or goals of care. A DNR or Do Not Hospitalize order is shown
//   as a neutral note under the flags and never hides or downgrades them.
// - Copy is neutral: "Consider urgent evaluation / transfer. Physician decision." Never a command,
//   never "do not send".
// - Tuned for older adults in skilled nursing facilities (atypical presentation, blunted fever and
//   heart rate responses, delirium superimposed on dementia). Guideline basis is cited per rule.
// - Thresholds reviewed by: ______ (physician), date ______.
import type { Resident } from "../db.js";
import type { ExtractedFacts } from "../types.js";
import type { Scores } from "../scores.js";

// ---------- clinical policy ----------

// Does an acute WORSENING of chronic confusion (e.g. dementia, baseline oriented to self only) count as
// an acute mental status change? Delirium superimposed on dementia is common and often missed, and is
// frequently the first sign of infection in older adults. RCP NEWS2 scores new confusion as 3.
// false = only confusion in a resident whose baseline is oriented x3 counts (original PLAN.md behavior).
// true  = any reported confusion or worsening counts (more sensitive). Chosen by the physician reviewer.
export const COUNT_WORSENING_OF_CHRONIC_CONFUSION = true;

// Fever in long-term care residents (IDSA, High et al., Clin Infect Dis 2009;48:149-171): a single oral
// temperature > 37.8 C (100 F), or a rise > 1.1 C (2 F) over the resident's baseline. Fever is absent in
// more than half of LTC residents with serious infection, so the hospital 38.0 C cutoff is too insensitive.
export const LTC_FEVER_C = 37.8;
export const LTC_FEVER_RISE_C = 1.1;
// Older adults with sepsis may be hypothermic instead of febrile (SIRS temperature criterion < 36.0 C).
export const HYPOTHERMIA_C = 36.0;

export const RED_FLAG_BANNER = "Consider urgent evaluation / transfer. Physician decision.";

// title is plain language for any audience; clinical is the medical term shown beneath it.
export type RedFlag = { id: string; title: string; clinical: string; why: string; evidence: string[] };

const ORIENTED_X3 = /oriented\s*(x|times)\s*3|a\s*&?\s*o\s*x\s*3|a&ox3/i;

export function baselineOrientedX3(r: Resident): boolean {
  return ORIENTED_X3.test(r.baseline.mental_status);
}

const CONFUSION = new Set(["new_confusion", "confusion", "worse_confusion", "worsening_confusion", "altered_mental_status", "disorientation", "delirium"]);

// Confusion reported on the call that counts as an ACUTE change under the policy above.
export function newConfusion(r: Resident, facts: ExtractedFacts | null): { quote: string } | null {
  const s = facts?.symptoms.find((x) => x.present && CONFUSION.has(x.name));
  if (!s) return null;
  return baselineOrientedX3(r) || COUNT_WORSENING_OF_CHRONIC_CONFUSION ? { quote: s.quote } : null;
}

function symptom(facts: ExtractedFacts | null, names: string[]) {
  return facts?.symptoms.find((s) => s.present && names.includes(s.name)) ?? null;
}

// Anticoagulants, plus antiplatelets other than aspirin monotherapy (NICE NG232 rec 1.5.13).
function bleedingRiskMeds(r: Resident) {
  const antiplatelets = r.medications.filter((m) => m.class === "antiplatelet");
  const aspirinOnly = antiplatelets.length > 0 && antiplatelets.every((m) => /aspirin/i.test(m.name));
  return r.medications.filter((m) => m.class === "anticoagulant" || (m.class === "antiplatelet" && !aspirinOnly));
}

// Medications that blunt or slow the heart rate response, shown as context on hemodynamic flags.
function rateContext(r: Resident): string[] {
  return r.medications
    .filter((m) => /beta blocker/i.test(m.class ?? "") || /donepezil|rivastigmine|galantamine|digoxin|diltiazem|verapamil/i.test(m.name))
    .map((m) => `On ${m.name} ${m.dose}: heart rate response may be blunted or slowed`);
}

const q = (quote: string) => `"${quote}"`;

export function evaluateRules(r: Resident, facts: ExtractedFacts | null, scores: Scores): RedFlag[] {
  const flags: RedFlag[] = [];
  const { current: v, baseline: b, news2 } = scores;
  const src = (x: { from: string; evidence: string }) => (x.from === "call" ? `heard on call: ${q(x.evidence)}` : `last chart value, ${x.evidence}`);
  const rateMeds = rateContext(r);

  const sbp = v.sbp!;
  const hr = v.hr!;
  const rr = v.rr!;
  const spo2 = v.spo2!;
  const temp = v.temp_c!;
  const conf = newConfusion(r, facts);

  // hypotension: SBP < 90, or SBP drop >= 40 from this resident's baseline
  if (sbp.value < 90 || (b.sbp !== undefined && b.sbp - sbp.value >= 40)) {
    flags.push({
      id: "hypotension",
      title: "Low blood pressure",
      clinical: "Hypotension",
      why: sbp.value < 90 ? `Systolic BP below 90 (usual ${b.sbp}).` : `Systolic BP ${b.sbp! - sbp.value} below this resident's baseline.`,
      evidence: [`SBP ${sbp.value} (${src(sbp)})`, `Baseline SBP ${b.sbp} (${b.source})`, ...rateMeds],
    });
  }

  // hypoxia: SpO2 < 90 on current O2, or new O2 requirement
  const chartOnRoomAir = r.vitals_history.every((x) => /^(ra|room air)$/i.test(x.o2));
  if (spo2.value < 90 || (v.o2.onOxygen && v.o2.from === "call" && chartOnRoomAir)) {
    flags.push({
      id: "hypoxia",
      title: "Low oxygen level",
      clinical: "Hypoxia",
      why: spo2.value < 90 ? `SpO2 below 90 on ${v.o2.value}.` : "New oxygen requirement; charted on room air for 14 days.",
      evidence: [`SpO2 ${spo2.value}% (${src(spo2)})`, `Oxygen: ${v.o2.value} (${src(v.o2)})`, `Baseline SpO2 ${b.spo2}%`],
    });
  }

  // tachycardia: HR > 130, or HR > 110 with SBP < 100
  if (hr.value > 130 || (hr.value > 110 && sbp.value < 100)) {
    flags.push({
      id: "tachycardia",
      title: "Fast heart rate",
      clinical: "Tachycardia",
      why: hr.value > 130 ? "Heart rate above 130." : "Heart rate above 110 with systolic BP below 100.",
      evidence: [`HR ${hr.value} (${src(hr)})`, `SBP ${sbp.value} (${src(sbp)})`, `Baseline HR ${b.hr}`, ...rateMeds],
    });
  }

  // bradycardia: HR < 50 (NEWS2 scores <= 50; older adults on rate-slowing drugs)
  if (hr.value < 50) {
    flags.push({ id: "bradycardia", title: "Slow heart rate", clinical: "Bradycardia", why: "Heart rate below 50.", evidence: [`HR ${hr.value} (${src(hr)})`, `Baseline HR ${b.hr}`, ...rateMeds] });
  }

  // tachypnea: RR >= 25 (NEWS2 scores 3)
  if (rr.value >= 25) {
    flags.push({ id: "tachypnea", title: "Fast breathing", clinical: "Tachypnea", why: "Respiratory rate 25 or higher.", evidence: [`RR ${rr.value} (${src(rr)})`, `Baseline RR ${b.rr}`] });
  }

  // sepsis_pattern: LTC fever (or hypothermia) AND organ dysfunction sign (qSOFA criteria: SBP <= 100, RR >= 22, acute mental status change)
  const rise = b.temp_c !== undefined ? Math.round((temp.value - b.temp_c) * 10) / 10 : 0;
  const ltcFever = temp.value > LTC_FEVER_C || rise > LTC_FEVER_RISE_C;
  const hypothermia = temp.value < HYPOTHERMIA_C;
  const lowSbp = sbp.value <= 100;
  const fastRr = rr.value >= 22;
  if ((ltcFever || hypothermia) && (lowSbp || fastRr || conf)) {
    const ev = [
      `Temp ${temp.value.toFixed(1)}°C (${src(temp)}), baseline ${b.temp_c?.toFixed(1)}°C`,
      hypothermia ? "Below 36.0°C: hypothermia can replace fever in older adults" : `Meets long-term care fever definition (>${LTC_FEVER_C}°C or >${LTC_FEVER_RISE_C}°C above baseline, IDSA)`,
    ];
    if (lowSbp) ev.push(`SBP ${sbp.value} (${src(sbp)})`);
    if (fastRr) ev.push(`RR ${rr.value} (${src(rr)})`);
    if (conf) ev.push(`Acute mental status change: ${q(conf.quote)}`);
    flags.push({
      id: "sepsis_pattern",
      title: "Possible sepsis",
      clinical: "Sepsis pattern: the body's dangerous response to infection",
      why: `${hypothermia ? "Low temperature" : temp.value < 38.0 ? "Fever by nursing home criteria (below the hospital 38.0 cutoff)" : "Fever"} with low BP, fast breathing, or acute confusion.`,
      evidence: [...ev, ...rateMeds],
    });
  }

  // qsofa: organ dysfunction pattern independent of temperature (afebrile sepsis is common in older adults)
  const qsofa = [lowSbp, fastRr, !!conf].filter(Boolean).length;
  if (qsofa >= 2) {
    const ev: string[] = [];
    if (lowSbp) ev.push(`SBP ${sbp.value} (≤100)`);
    if (fastRr) ev.push(`RR ${rr.value} (≥22)`);
    if (conf) ev.push(`Acute mental status change: ${q(conf.quote)}`);
    flags.push({ id: "qsofa", title: `Organ stress signs: ${qsofa} of 3`, clinical: `qSOFA ${qsofa}`, why: "Low blood pressure, fast breathing, or sudden confusion. Two or more suggest organs are under strain, with or without fever.", evidence: ev });
  }

  // fall_anticoag: fall AND (head strike OR unwitnessed) AND anticoagulant / non-aspirin antiplatelet (NICE NG232)
  const fall = facts?.events.find((e) => e.type === "fall");
  const headStrike = fall?.head_strike === true || !!symptom(facts, ["head_strike", "head_injury"]);
  const bleedMeds = bleedingRiskMeds(r);
  if (fall && (headStrike || fall.witnessed === false) && bleedMeds.length) {
    const anticoag = bleedMeds.some((m) => m.class === "anticoagulant");
    flags.push({
      id: "fall_anticoag",
      title: "Fall on a blood thinner",
      clinical: anticoag ? "Fall on anticoagulant" : "Fall on antiplatelet",
      why: `${fall.witnessed === false ? "Unwitnessed fall" : "Fall"}${headStrike ? " with head strike" : ""} in a resident on ${anticoag ? "an anticoagulant" : "antiplatelet therapy"}: risk of intracranial bleeding. NICE NG232: consider CT head within 8 hours.`,
      evidence: [`Fall: ${q(fall.quote)}`, ...bleedMeds.map((m) => `${m.name} ${m.dose} (medication list)`)],
    });
  }

  // acute_mental_status_change: possible delirium, from any baseline (delirium superimposed on dementia counts)
  if (conf) {
    const dementia = !baselineOrientedX3(r);
    flags.push({
      id: "acute_mental_status_change",
      title: "Sudden confusion",
      clinical: "Acute mental status change, possible delirium",
      why: dementia
        ? "Worse than this resident's usual cognition: possible delirium superimposed on dementia, often the first sign of infection."
        : "New confusion in a resident whose baseline is alert and oriented x3: possible delirium.",
      evidence: [`Tonight: ${q(conf.quote)}`, `Baseline: ${r.baseline.mental_status} (${r.baseline.source})`],
    });
  }

  // stroke_signs: focal weakness, facial droop, or new speech change
  const stroke = symptom(facts, ["focal_weakness", "facial_droop", "speech_change", "slurred_speech", "aphasia"]);
  if (stroke) {
    flags.push({ id: "stroke_signs", title: "Possible stroke signs", clinical: "Focal neurologic deficit", why: "Focal weakness, facial droop, or new speech change reported.", evidence: [q(stroke.quote)] });
  }

  // chest_pain: chest pain reported
  const cp = symptom(facts, ["chest_pain"]);
  if (cp) {
    flags.push({ id: "chest_pain", title: "Chest pain", clinical: "Possible acute coronary syndrome", why: "Chest pain reported.", evidence: [q(cp.quote)] });
  }

  // news2_high: NEWS2 >= 7, or any single parameter scoring 3 (RCP 2017)
  if (news2.total >= 7 || news2.anyThree) {
    const threes = news2.parts.filter((p) => p.points === 3).map((p) => `${p.param} ${p.value} scores 3`);
    flags.push({
      id: "news2_high",
      title: `Early warning score ${news2.total}${news2.total >= 7 ? " (high risk)" : ""}`,
      clinical: "NEWS2 (UK national early warning score, 0 to 20)",
      why: news2.total >= 7 ? "Score of 7 or more: high risk of deterioration." : "One vital sign alone is in the most abnormal range.",
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
