// In-memory call state. Every change is pushed to SSE subscribers as the full CallState.
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { getResident, getScript, type Resident, type ScriptLine } from "./db.js";
import { runPipeline } from "./pipeline.js";
import { recallForResident } from "./memory.js";
import type { CoveredItem, ExtractedFacts, PriorCallMemory, UnsaidItem } from "./types.js";
import type { Scores } from "./scores.js";
import type { RedFlag } from "./safety/rules.js";
import type { FeasibilityItem } from "./feasibility.js";
import { anchorReady, prepareEhrSession, readChartFromEhr, type EhrAgent, type PreparedSession } from "./anchor.js";

export type Speaker = "nurse" | "doctor" | "unknown";
export type Segment = { id: string; ts: number; speaker?: Speaker; text: string };

export type CallState = {
  callId: string;
  residentId: string;
  startedAt: number;
  segments: Segment[];
  facts: ExtractedFacts | null;
  unsaid: UnsaidItem[];
  covered: CoveredItem[];
  redFlags: RedFlag[];
  goalsNote: string | null;
  scores: Scores | null;
  feasibility: FeasibilityItem[];
  priorCalls: PriorCallMemory[];
  priorCallsNote: string | null;
  memoryBackend: string | null;
  status: "live" | "ended";
  replaying: boolean;
  // Clock the call is "happening" at. Replays run on scenario time (2:05 AM); live calls use real time.
  clockStart: number;
  processing: boolean;
  pipelineError: string | null;
  disposition: "transfer" | "treat_in_place" | null;
  note: string | null;
  signedBy: string | null;
  ehrPost: { status: "posting" | "posted" | "failed"; detail: string } | null;
  ehrAgent: EhrAgent | null;
  // Chart for this call: read from the facility EHR portal by Anchor, or the local copy as fallback.
  chartSource: "ehr" | "local" | "pending";
  wantsEhr: boolean;
};

const charts = new Map<string, { chart: Resident | null; pending: Promise<Resident | null> | null }>();

// The chart every pipeline step uses for this call. Waits (bounded) for an in-flight EHR read.
export async function chartFor(state: CallState): Promise<Resident> {
  const c = charts.get(state.callId);
  if (c?.chart) return c.chart;
  if (c?.pending) {
    const got = await Promise.race([c.pending, new Promise<null>((res) => setTimeout(() => res(null), 25_000))]);
    if (got) return got;
  }
  return getResident(state.residentId)!;
}

const preparedSessions = new Map<string, Promise<PreparedSession>>();

// At call start: open the portal in the cloud browser so its live view is already streaming.
export function prepareEhr(state: CallState) {
  state.wantsEhr = true;
  state.ehrAgent = { status: "starting", task: "pull", liveViewUrl: null, detail: "Opening the facility EHR portal", found: [], matchesChart: null, ms: null };
  const p = prepareEhrSession(state.ehrAgent, () => broadcast(state));
  p.catch(() => {}); // failures surface when the read starts
  preparedSessions.set(state.callId, p);
}

function startEhrRead(state: CallState) {
  const resident = getResident(state.residentId)!;
  state.ehrAgent ??= { status: "starting", task: "pull", liveViewUrl: null, detail: "Opening a cloud browser for the facility EHR portal", found: [], matchesChart: null, ms: null };
  state.chartSource = "pending";
  const pending = readChartFromEhr(resident, state.ehrAgent, () => broadcast(state), preparedSessions.get(state.callId))
    .then((chart) => {
      charts.set(state.callId, { chart, pending: null });
      state.chartSource = "ehr";
      return chart;
    })
    .catch(() => {
      charts.set(state.callId, { chart: null, pending: null });
      state.chartSource = "local";
      return null;
    })
    .finally(() => {
      broadcast(state);
      schedulePipeline(state); // refresh the panels with the chart as soon as it arrives
    });
  charts.set(state.callId, { chart: null, pending });
}

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
    covered: [],
    redFlags: [],
    goalsNote: null,
    scores: null,
    feasibility: [],
    priorCalls: [],
    priorCallsNote: null,
    memoryBackend: null,
    status: "live",
    replaying: false,
    clockStart: Date.now(),
    processing: false,
    pipelineError: null,
    disposition: null,
    note: null,
    signedBy: null,
    ehrPost: null,
    ehrAgent: null,
    chartSource: "local",
    wantsEhr: false,
  };
  calls.set(state.callId, state);
  // Recall this resident's prior night calls from Agent Memory at call start.
  recallForResident(residentId).then((r) => {
    state.priorCalls = r.items;
    state.priorCallsNote = priorCallsNote(r.items);
    state.memoryBackend = r.backend;
    broadcast(state);
  });
  return state;
}

const DAY = 24 * 60 * 60 * 1000;
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

// "3rd call this week for this resident" when 2 or more prior calls in the last 7 days.
function priorCallsNote(items: PriorCallMemory[]): string | null {
  const recent = items.filter((m) => m.ts && Date.now() - new Date(m.ts).getTime() <= 7 * DAY).length;
  return recent >= 2 ? `${ordinal(recent + 1)} call this week for this resident` : null;
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
  // The nurse's first line (facility, resident, room) starts the EHR read.
  if (state.wantsEhr && state.segments.length === 1 && anchorReady().ok) startEhrRead(state);
  broadcast(state);
  schedulePipeline(state);
  return seg;
}

const running = new Set<string>();
const rerunQueued = new Set<string>();

// Bursts of segments within 700 ms run the pipeline once. Runs never overlap for a call:
// segments that arrive mid-run queue exactly one follow-up run over the full transcript.
function schedulePipeline(state: CallState) {
  clearTimeout(debounceTimers.get(state.callId));
  debounceTimers.set(state.callId, setTimeout(() => void runNow(state), 700));
}

async function runNow(state: CallState) {
  if (running.has(state.callId)) {
    rerunQueued.add(state.callId);
    return;
  }
  running.add(state.callId);
  state.processing = true;
  broadcast(state);
  try {
    await runPipeline(state);
    state.pipelineError = null;
  } catch (err) {
    state.pipelineError = (err as Error).message;
    console.error(`[pipeline] ${state.callId}: ${state.pipelineError}`);
  } finally {
    running.delete(state.callId);
    state.processing = false;
    broadcast(state);
  }
  if (rerunQueued.delete(state.callId)) void runNow(state);
}

// Replays (silent or voiced) run on scenario time: the call "starts" at 2:05 AM.
export function setReplaying(state: CallState, on: boolean) {
  state.replaying = on;
  if (on) {
    const scenario = new Date();
    scenario.setHours(2, 5, 0, 0);
    state.clockStart = scenario.getTime() - (Date.now() - state.startedAt);
  }
  broadcast(state);
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
  setReplaying(state, true);
  for (const line of lines) {
    await sleep(line.delayMs);
    if (state.status !== "live" || !state.replaying) return;
    addSegment(state, line.text, line.speaker);
  }
  state.replaying = false;
  broadcast(state);
}
