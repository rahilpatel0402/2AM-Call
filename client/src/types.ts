// Mirrors server/src/types.ts and the CallState shape pushed over SSE.

export type ResidentSummary = { id: string; name: string; age: number; sex: string; room: string };

export type ResidentDetail = {
  resident: { id: string; name: string; age: number; sex: string; room: string; pcp: string; admitted: string; diagnoses: string[] };
  facility: { id: string; name: string };
};

export type Segment = { id: string; ts: number; speaker?: "nurse" | "doctor" | "unknown"; text: string };

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
  mentioned_checklist: { item: string; mentioned: boolean; quote?: string }[];
  dropped: { kind: string; quote: string; reason: string }[];
};

export type UnsaidItem = {
  item: string;
  label: string;
  value: string;
  source: { doc: string; field: string; label: string };
};

export type CoveredItem = { item: string; label: string; quote: string };

export type PriorCallMemory = { ts: string; text: string; source: string; backend: string };

export type RedFlag = { id: string; title: string; plain: string; why: string; evidence: string[] };

export type VitalKey = "sbp" | "dbp" | "hr" | "rr" | "temp_c" | "spo2";
export type VitalReading = { value: number; from: "call" | "chart"; evidence: string };
export type Delta = { key: string; label: string; current: number; baseline: number; diff: number; from: "call" | "chart" };
export type News2 = { total: number; parts: { param: string; value: string; points: number }[]; band: "low" | "low-medium" | "medium" | "high"; anyThree: boolean; complete: boolean };
export type Scores = {
  current: Partial<Record<VitalKey, VitalReading>> & { o2: { value: string; onOxygen: boolean; from: string; evidence: string }; consciousness: { value: string; from: string; evidence: string } };
  baseline: Partial<Record<VitalKey, number>> & { n: number; source: string };
  deltas: Delta[];
  news2: News2;
};

export type FeasibilityItem = { need: string; capability: string; available: boolean; detail: string; source: string };

export type CallState = {
  callId: string;
  residentId: string;
  startedAt: number;
  clockStart: number;
  segments: Segment[];
  facts: ExtractedFacts | null;
  unsaid: UnsaidItem[];
  covered: CoveredItem[];
  priorCalls: PriorCallMemory[];
  priorCallsNote: string | null;
  redFlags: RedFlag[];
  goalsNote: string | null;
  scores: Scores | null;
  feasibility: FeasibilityItem[];
  memoryBackend: string | null;
  status: "live" | "ended";
  replaying: boolean;
  processing: boolean;
  pipelineError: string | null;
  disposition: "transfer" | "treat_in_place" | null;
  note: string | null;
  signedBy: string | null;
  ehrPost: { status: "posting" | "posted" | "failed"; detail: string } | null;
  ehrAgent: import("./Panels").EhrAgent | null;
  chartSource: "ehr" | "local" | "pending";
};
