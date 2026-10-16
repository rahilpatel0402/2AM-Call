// Per-call pipeline, run after each (debounced) burst of transcript segments.
// Phase 3 adds extraction + unsaid; Phase 4 adds rules, scores, feasibility, prior calls.
import type { CallState } from "./calls.js";

export async function runPipeline(_state: CallState): Promise<void> {
  // Steps are added in later phases.
}
