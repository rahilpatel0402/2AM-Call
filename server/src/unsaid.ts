// "What wasn't said": deterministic. For each checklist item NOT mentioned on the call,
// pull the value from the chart and attach its source. No LLM involved.
import type { Resident } from "./db.js";
import type { ChecklistItem, CoveredItem, ExtractedFacts, PriorCallMemory, UnsaidItem } from "./types.js";

// Display priority (most important first).
const PRIORITY: ChecklistItem[] = [
  "anticoagulation",
  "code_status",
  "baseline_mental_status",
  "recent_hospitalization",
  "goals_of_care",
  "prior_calls",
  "recent_labs",
  "allergies",
];

const DAY = 24 * 60 * 60 * 1000;

// Chart dates are local facility time; a bare "YYYY-MM-DD" would otherwise parse as UTC midnight.
function localTime(ts: string): number {
  return new Date(ts.length === 10 ? `${ts}T00:00:00` : ts).getTime();
}

function shortDate(ts: string): string {
  return new Date(localTime(ts)).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function chartValue(item: ChecklistItem, r: Resident, priorCalls: PriorCallMemory[], now: number): UnsaidItem | null {
  switch (item) {
    case "anticoagulation": {
      const idx = r.medications.findIndex((m) => m.class === "anticoagulant" || m.class === "antiplatelet");
      if (idx < 0) return null;
      const meds = r.medications.filter((m) => m.class === "anticoagulant" || m.class === "antiplatelet");
      const label = meds.some((m) => m.class === "anticoagulant") ? "Anticoagulant" : "Antiplatelet";
      return {
        item, label,
        value: meds.map((m) => `${m.name} ${m.dose}`).join(", "),
        source: { doc: r.id, field: `medications[${idx}]`, label: "medication list" },
      };
    }
    case "code_status":
      return {
        item, label: "Code status / MOLST",
        value: `${r.code_status.value}. MOLST: ${r.code_status.molst}`,
        source: { doc: r.code_status.source, field: "code_status", label: r.code_status.source },
      };
    case "baseline_mental_status":
      return {
        item, label: "Baseline mental status",
        value: r.baseline.mental_status,
        source: { doc: r.baseline.source, field: "baseline.mental_status", label: r.baseline.source },
      };
    case "recent_hospitalization": {
      const h = r.recent_hospitalization;
      if (!h) return null;
      const days = Math.floor((now - localTime(h.discharged)) / DAY);
      if (days > 30) return null;
      return {
        item, label: "Recent hospitalization",
        value: `Discharged ${days} days ago (${shortDate(h.discharged)}): ${h.reason}`,
        source: { doc: h.source, field: "recent_hospitalization", label: h.source },
      };
    }
    case "goals_of_care":
      return {
        item, label: "Goals of care",
        value: r.goals_of_care.summary,
        source: { doc: r.goals_of_care.source, field: "goals_of_care.summary", label: r.goals_of_care.source },
      };
    case "prior_calls": {
      const recent = priorCalls.filter((c) => c.ts && now - localTime(c.ts) <= 7 * DAY);
      if (!recent.length) return null;
      return {
        item, label: "Prior night calls",
        value: `${recent.length} on-call call${recent.length > 1 ? "s" : ""} in the last 7 days (${recent.map((c) => shortDate(c.ts)).join(", ")})`,
        source: { doc: "on-call memory", field: "prior_calls", label: recent[0].source },
      };
    }
    case "recent_labs": {
      const latest = (name: string) => r.labs.filter((l) => l.name === name).sort((a, b) => b.ts.localeCompare(a.ts))[0];
      const parts = ["creatinine", "hemoglobin"]
        .map(latest)
        .filter(Boolean)
        .map((l) => `${l!.name} ${l!.value} ${l!.unit} (${shortDate(l!.ts)})`);
      if (!parts.length) return null;
      return {
        item, label: "Recent labs",
        value: parts.join(", "),
        source: { doc: r.id, field: "labs", label: "lab results" },
      };
    }
    case "allergies":
      return {
        item, label: "Allergies",
        value: r.allergies.join(", "),
        source: { doc: r.id, field: "allergies", label: "allergy list" },
      };
  }
}

const LABELS: Record<ChecklistItem, string> = {
  anticoagulation: "Anticoagulation",
  code_status: "Code status / MOLST",
  baseline_mental_status: "Baseline mental status",
  recent_hospitalization: "Recent hospitalization",
  goals_of_care: "Goals of care",
  prior_calls: "Prior night calls",
  recent_labs: "Recent labs",
  allergies: "Allergies",
};

export function computeCovered(facts: ExtractedFacts): CoveredItem[] {
  return PRIORITY.flatMap((item) => {
    const m = facts.mentioned_checklist.find((x) => x.item === item && x.mentioned && x.quote);
    return m ? [{ item, label: LABELS[item], quote: m.quote! }] : [];
  });
}

export function computeUnsaid(r: Resident, facts: ExtractedFacts, priorCalls: PriorCallMemory[], now = Date.now()): UnsaidItem[] {
  const mentioned = new Set(facts.mentioned_checklist.filter((m) => m.mentioned).map((m) => m.item));
  return PRIORITY.filter((item) => !mentioned.has(item))
    .map((item) => chartValue(item, r, priorCalls, now))
    .filter((x): x is UnsaidItem => x !== null);
}
