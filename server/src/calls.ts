// In-memory call state. Every change is pushed to SSE subscribers as the full CallState.
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { getScript, type ScriptLine } from "./db.js";
import { runPipeline } from "./pipeline.js";

export type Speaker = "nurse" | "doctor" | "unknown";
export type Segment = { id: string; ts: number; speaker?: Speaker; text: string };

export type CallState = {
  callId: string;
  residentId: string;
  startedAt: number;
  segments: Segment[];
  facts: unknown | null;       // Phase 3
  unsaid: unknown[];           // Phase 3
  redFlags: unknown[];         // Phase 4
  scores: unknown | null;      // Phase 4
  feasibility: unknown[];      // Phase 4
  priorCalls: unknown[];       // Phase 4
  status: "live" | "ended";
  replaying: boolean;
};

const calls = new Map<string, CallState>();
const subscribers = new Map<string, Set<Response>>();
const debounceTimers = new Map<string, NodeJS.Timeout>();

export function createCall(residentId: string): CallState {
  const state: CallState = {
    callId: randomUUID().slice(0, 8),
    residentId,
    startedAt: Date.now(),
    segments: [],
    facts: null,
    unsaid: [],
    redFlags: [],
    scores: null,
    feasibility: [],
    priorCalls: [],
    status: "live",
    replaying: false,
  };
  calls.set(state.callId, state);
  return state;
}

export function getCall(callId: string): CallState | undefined {
  return calls.get(callId);
}

export function broadcast(state: CallState) {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of subscribers.get(state.callId) ?? []) res.write(payload);
}

export function subscribe(state: CallState, res: Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify(state)}\n\n`);
  const set = subscribers.get(state.callId) ?? new Set<Response>();
  set.add(res);
  subscribers.set(state.callId, set);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  res.on("close", () => {
    clearInterval(ping);
    set.delete(res);
  });
}

export function addSegment(state: CallState, text: string, speaker: Speaker = "unknown"): Segment {
  const seg: Segment = { id: randomUUID().slice(0, 8), ts: Date.now(), speaker, text: text.trim() };
  state.segments.push(seg);
  broadcast(state);
  schedulePipeline(state);
  return seg;
}

// Bursts of segments within 700 ms run the pipeline once.
function schedulePipeline(state: CallState) {
  clearTimeout(debounceTimers.get(state.callId));
  debounceTimers.set(
    state.callId,
    setTimeout(async () => {
      try {
        await runPipeline(state);
      } catch (err) {
        console.error(`[pipeline] ${state.callId}: ${(err as Error).message}`);
      }
      broadcast(state);
    }, 700),
  );
}

export function endCall(state: CallState) {
  state.status = "ended";
  state.replaying = false;
  broadcast(state);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Streams a scripted call into segments using each line's delayMs. Stops if the call ends.
export async function replay(state: CallState, scriptName: string): Promise<void> {
  const lines: ScriptLine[] | undefined = getScript(scriptName);
  if (!lines) throw new Error(`unknown script "${scriptName}"`);
  state.replaying = true;
  broadcast(state);
  for (const line of lines) {
    await sleep(line.delayMs);
    if (state.status !== "live" || !state.replaying) return;
    addSegment(state, line.text, line.speaker);
  }
  state.replaying = false;
  broadcast(state);
}
