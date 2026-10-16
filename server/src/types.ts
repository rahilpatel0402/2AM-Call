// Shared types for the call pipeline.

export const CHECKLIST_ITEMS = [
  "code_status",
  "anticoagulation",
  "baseline_mental_status",
  "allergies",
  "recent_hospitalization",
  "goals_of_care",
  "recent_labs",
  "prior_calls",
] as const;
export type ChecklistItem = (typeof CHECKLIST_ITEMS)[number];

export type ReportedVitals = {
  sbp?: number; dbp?: number; hr?: number; rr?: number;
  temp_c?: number; temp_f?: number; spo2?: number; o2?: string;
  quote: string;
};

export type ExtractedFacts = {
  chief_concern: { text: string; quote: string } | null;
  onset: { text: string; quote: string } | null;
  vitals_reported: ReportedVitals[];
  symptoms: { name: string; present: boolean; quote: string }[];
  events: { type: "fall" | "other"; witnessed?: boolean; head_strike?: boolean; quote: string }[];
  mentioned_checklist: { item: ChecklistItem; mentioned: boolean; quote?: string }[];
  // Anti-hallucination audit: anything the model returned that failed validation in code.
  dropped: { kind: string; quote: string; reason: string }[];
};

export type SourceRef = { doc: string; field: string; label: string };

export type UnsaidItem = {
  item: ChecklistItem;
  label: string;
  value: string;
  source: SourceRef;
};

// A checklist item the call DID cover, with the quote that covered it.
export type CoveredItem = { item: ChecklistItem; label: string; quote: string };

export type PriorCallMemory = { ts: string; text: string; source: string; backend: string };
