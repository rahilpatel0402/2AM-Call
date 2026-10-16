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

export type CallState = {
  callId: string;
  residentId: string;
  startedAt: number;
  segments: Segment[];
  facts: ExtractedFacts | null;
  unsaid: UnsaidItem[];
  covered: CoveredItem[];
  priorCalls: PriorCallMemory[];
  memoryBackend: string | null;
  status: "live" | "ended";
  replaying: boolean;
  processing: boolean;
  pipelineError: string | null;
};
