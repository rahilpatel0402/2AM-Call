// Treat-in-place feasibility: map likely needs (from facts and red flags) to what THIS facility can do tonight.
// Deterministic. Neutral wording: shows capability, never recommends a disposition.
import type { Facility, Resident } from "./db.js";
import type { ExtractedFacts } from "./types.js";
import type { RedFlag } from "./safety/rules.js";
import type { Scores } from "./scores.js";

export type FeasibilityItem = {
  need: string;          // why this capability is relevant tonight
  capability: string;    // what it is
  available: boolean;
  detail: string;        // e.g. "results by about 06:00"
  source: string;        // facility.overnight.<field>
};

function clockPlus(hours: number, now: Date): string {
  const t = new Date(now.getTime() + hours * 3600_000);
  return t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

const has = (facts: ExtractedFacts | null, names: string[]) => !!facts?.symptoms.some((s) => s.present && names.includes(s.name));

export function computeFeasibility(r: Resident, f: Facility, facts: ExtractedFacts | null, flags: RedFlag[], scores: Scores, now = new Date()): FeasibilityItem[] {
  const o = f.overnight;
  const ids = new Set(flags.map((x) => x.id));
  const items: FeasibilityItem[] = [];
  const add = (it: FeasibilityItem) => {
    if (!items.some((x) => x.capability === it.capability)) items.push(it);
  };

  const fever = (scores.current.temp_c?.from === "call" && scores.current.temp_c.value >= 38.0) || has(facts, ["fever", "chills"]);
  const infection = fever || ids.has("sepsis_pattern") || has(facts, ["urinary_change", "dysuria", "cough"]);
  const fall = !!facts?.events.some((e) => e.type === "fall");
  const headStrike = !!facts?.events.some((e) => e.type === "fall" && e.head_strike) || has(facts, ["head_strike", "head_injury"]);
  const limbPain = fall && has(facts, ["pain", "hip_pain", "limb_pain"]);
  const breathing = ids.has("hypoxia") || ids.has("tachypnea") || has(facts, ["dyspnea", "shortness_of_breath"]);
  const lowBp = ids.has("hypotension");
  const chestPain = ids.has("chest_pain");
  const poorIntake = has(facts, ["poor_intake", "dehydration"]);

  if (infection || lowBp) {
    add({ need: infection ? "Possible infection" : "Low blood pressure", capability: "Stat labs (CBC, BMP, cultures)", available: o.stat_labs.available,
      detail: o.stat_labs.available ? `about ${o.stat_labs.turnaround_hours} h turnaround, results by about ${clockPlus(o.stat_labs.turnaround_hours, now)}` : "not available overnight",
      source: "facility.overnight.stat_labs" });
  }
  if (infection) {
    add({ need: "Possible infection", capability: "IV antibiotics", available: o.iv_antibiotics,
      detail: o.iv_antibiotics ? `pharmacy stat delivery about ${o.pharmacy_stat_delivery_hours} h` : "not available overnight", source: "facility.overnight.iv_antibiotics" });
  }
  if (infection || lowBp || poorIntake) {
    add({ need: lowBp ? "Low blood pressure" : poorIntake ? "Poor oral intake" : "Possible infection", capability: "IV fluids", available: o.iv_fluids,
      detail: o.iv_fluids ? "available tonight" : "not available overnight", source: "facility.overnight.iv_fluids" });
  }
  if (lowBp) {
    add({ need: "Low blood pressure", capability: "Continuous cardiac monitoring", available: o.telemetry,
      detail: o.telemetry ? "available" : "no telemetry overnight", source: "facility.overnight.telemetry" });
  }
  if (headStrike) {
    add({ need: "Head strike", capability: "CT head", available: o.ct_imaging,
      detail: o.ct_imaging ? "available tonight" : "not available tonight (no on-site CT)", source: "facility.overnight.ct_imaging" });
  }
  if (limbPain || (infection && has(facts, ["cough"])) || breathing) {
    add({ need: limbPain ? "Pain after fall" : "Respiratory symptoms", capability: "Mobile X-ray", available: o.mobile_xray.available,
      detail: o.mobile_xray.available ? `earliest ${o.mobile_xray.earliest}` : "not available", source: "facility.overnight.mobile_xray" });
  }
  if (breathing) {
    add({ need: "Breathing", capability: `Oxygen up to ${o.oxygen_max_lpm} L/min`, available: o.oxygen_max_lpm > 0,
      detail: "no high-flow oxygen or BiPAP", source: "facility.overnight.oxygen_max_lpm" });
  }
  if (chestPain) {
    add({ need: "Chest pain", capability: "Cardiac telemetry", available: o.telemetry,
      detail: o.telemetry ? "available" : "not available overnight", source: "facility.overnight.telemetry" });
  }
  if (items.length) {
    add({ need: "Overnight staffing", capability: "RN on site", available: o.rn_on_site, detail: o.rn_on_site ? "for reassessment overnight" : "no RN overnight", source: "facility.overnight.rn_on_site" });
  }
  return items;
}
