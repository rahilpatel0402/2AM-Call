// Per-call pipeline, run after each (debounced) burst of transcript segments.
// Phase 4 adds rules, scores, feasibility.
import type { CallState } from "./calls.js";
import { getResident } from "./db.js";
import { extractFacts } from "./extract.js";
import { computeCovered, computeUnsaid } from "./unsaid.js";

export async function runPipeline(state: CallState): Promise<void> {
  const resident = getResident(state.residentId);
  if (!resident || !state.segments.length) return;

  // 1. Claude extraction (quotes validated inside extractFacts).
  const t0 = Date.now();
  state.facts = await extractFacts(state.segments);
  console.log(`[pipeline] ${state.callId} extract ${Date.now() - t0} ms, ${state.segments.length} segments`);

  // 2. What wasn't said (deterministic, chart sourced).
  state.unsaid = computeUnsaid(resident, state.facts, state.priorCalls);
  state.covered = computeCovered(state.facts);
}
