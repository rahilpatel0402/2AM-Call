// Per-call pipeline, run after each (debounced) burst of transcript segments.
//   1. extract.ts    Claude -> structured facts (quotes validated in code)
//   2. unsaid.ts     checklist vs mentioned -> chart values with sources
//   3. scores.ts     current vitals, baseline deltas, NEWS2 (pure TS)
//   4. safety/rules  deterministic red flags (no LLM input except validated facts)
//   5. feasibility   facility capability tonight
import type { CallState } from "./calls.js";
import { getFacilityForResident, getResident } from "./db.js";
import { extractFacts } from "./extract.js";
import { computeCovered, computeUnsaid } from "./unsaid.js";
import { computeScores } from "./scores.js";
import { evaluateRules, goalsOfCareNote } from "./safety/rules.js";
import { computeFeasibility } from "./feasibility.js";

// Wall clock of the call: scenario start plus elapsed real time.
function callClock(state: CallState): Date {
  return new Date(state.clockStart + (Date.now() - state.startedAt));
}

export async function runPipeline(state: CallState): Promise<void> {
  const resident = getResident(state.residentId);
  if (!resident || !state.segments.length) return;

  const t0 = Date.now();
  state.facts = await extractFacts(state.segments);
  const t1 = Date.now();

  state.unsaid = computeUnsaid(resident, state.facts, state.priorCalls, state.segments.map((s) => s.text).join(" "));
  state.covered = computeCovered(state.facts);
  state.scores = computeScores(resident, state.facts);
  state.redFlags = evaluateRules(resident, state.facts, state.scores);
  state.goalsNote = goalsOfCareNote(resident);
  state.feasibility = computeFeasibility(resident, getFacilityForResident(resident.id), state.facts, state.redFlags, state.scores, callClock(state));

  console.log(
    `[pipeline] ${state.callId} extract ${t1 - t0} ms, rules ${Date.now() - t1} ms, flags: ${state.redFlags.map((f) => f.id).join(",") || "none"}`,
  );
}
