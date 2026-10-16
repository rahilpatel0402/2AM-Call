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
import { inSession, span } from "./tracing.js";

// Wall clock of the call: scenario start plus elapsed real time.
function callClock(state: CallState): Date {
  return new Date(state.clockStart + (Date.now() - state.startedAt));
}

// Traced in Arize: one session per call, one pipeline.run trace per update, Bedrock spans auto-captured.
export async function runPipeline(state: CallState): Promise<void> {
  const resident = getResident(state.residentId);
  if (!resident || !state.segments.length) return;
  await inSession(state.callId, () =>
    span("pipeline.run", "CHAIN", { "call.id": state.callId, "resident.id": resident.id, "segments.count": state.segments.length, "input.value": state.segments.at(-1)!.text }, () =>
      runSteps(state, resident),
    ),
  );
}

async function runSteps(state: CallState, resident: NonNullable<ReturnType<typeof getResident>>): Promise<void> {
  const t0 = Date.now();
  state.facts = await extractFacts(state.segments);
  const t1 = Date.now();
  const facts = state.facts;

  // Anti-hallucination audit: how many model items survived quote validation.
  await span("extract.validate_quotes", "GUARDRAIL", {}, () => facts, (f) => ({
    "quotes.kept": f.vitals_reported.length + f.symptoms.length + f.events.length + f.mentioned_checklist.filter((m) => m.mentioned).length,
    "quotes.dropped": f.dropped.length,
    "quotes.dropped_detail": JSON.stringify(f.dropped),
  }));

  state.unsaid = await span("unsaid.compute", "CHAIN", {}, () => computeUnsaid(resident, facts, state.priorCalls, state.segments.map((s) => s.text).join(" ")),
    (u) => ({ "unsaid.count": u.length, "unsaid.items": u.map((x) => x.item).join(",") }));
  state.covered = computeCovered(facts);
  state.scores = computeScores(resident, facts);
  const scores = state.scores;
  state.redFlags = await span("safety.rules", "GUARDRAIL", { "news2.total": scores.news2.total }, () => evaluateRules(resident, facts, scores),
    (f) => ({ "rules.fired": f.map((x) => x.id).join(",") || "none", "rules.count": f.length, "output.value": f.map((x) => x.title).join(", ") || "none" }));
  state.goalsNote = goalsOfCareNote(resident);
  state.feasibility = computeFeasibility(resident, getFacilityForResident(resident.id), facts, state.redFlags, scores, callClock(state));

  console.log(
    `[pipeline] ${state.callId} extract ${t1 - t0} ms, rules ${Date.now() - t1} ms, flags: ${state.redFlags.map((f) => f.id).join(",") || "none"}`,
  );
}
