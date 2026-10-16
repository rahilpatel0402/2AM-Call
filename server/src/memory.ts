// On-call memory: what happened on prior night calls, what was decided, what the family said.
// Backed by hosted SurrealDB Agent Memory (REST, old product name Spectron) when SPECTRON_* is set.
// Fallback: an in-memory array with the same helpers, used when keys are missing or the service errors.
//
// Resident isolation: every memory text carries a "[resident:<id>]" tag, and recall keeps only hits
// with the caller's tag, so one resident's memories never show up on another resident's call.
import "./env.js";
import { env } from "./env.js";
import { getResident, seedPriorCalls, type PriorCall } from "./db.js";

export type MemoryItem = {
  ts: string;
  text: string;
  source: string;
  backend: "agent-memory" | "local";
  traceId?: string;
};

export type RecallResult = { backend: "agent-memory" | "local"; items: MemoryItem[]; error?: string };

export type CallRecord = Omit<PriorCall, "id"> & { id?: string };

const local: (MemoryItem & { residentId: string })[] = [];

function tag(residentId: string) {
  return `[resident:${residentId}]`;
}

function toText(c: CallRecord): string {
  return `${tag(c.residentId)} On-call ${c.ts.slice(0, 16)} with ${c.physician}. Reason: ${c.reason}. Disposition: ${c.disposition}. ${c.summary}`;
}

// Chart timestamps are local facility time without offset; Agent Memory wants RFC 3339.
function rfc3339(ts: string): string {
  return /[zZ]|[+-]\d\d:\d\d$/.test(ts) ? ts : `${ts.length === 16 ? ts + ":00" : ts}-04:00`;
}

function remoteConfigured(): boolean {
  return Boolean(env("SPECTRON_ENDPOINT") && env("SPECTRON_CONTEXT") && env("SPECTRON_API_KEY"));
}

async function remote(pathname: string, body: unknown, idempotencyKey?: string): Promise<any> {
  const base = `${env("SPECTRON_ENDPOINT").replace(/\/+$/, "")}/api/v1/${env("SPECTRON_CONTEXT")}`;
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("SPECTRON_API_KEY")}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok && res.status !== 409) throw new Error(`Agent Memory ${pathname} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 409 ? {} : res.json();
}

export async function rememberCall(call: CallRecord): Promise<void> {
  const text = toText(call);
  local.push({ residentId: call.residentId, ts: call.ts, text, source: "local fallback store", backend: "local" });
  if (!remoteConfigured()) return;
  // infer "none" stores the text verbatim so the resident tag survives for filtering on recall.
  await remote("/facts", { text, infer: "none", observed_at: rfc3339(call.ts) }, call.id);
}

let seeded: Promise<void> | null = null;

export function seedMemory(): Promise<void> {
  seeded ??= (async () => {
    for (const c of seedPriorCalls) {
      try {
        await rememberCall(c);
      } catch (err) {
        console.warn(`[memory] seed failed for ${c.id}: ${(err as Error).message}`);
      }
    }
    console.log(`[memory] seeded ${seedPriorCalls.length} prior calls (${remoteConfigured() ? "SurrealDB Agent Memory" : "local fallback"})`);
  })();
  return seeded;
}

function recallLocal(residentId: string): MemoryItem[] {
  return local
    .filter((m) => m.residentId === residentId)
    .map(({ residentId: _r, ...m }) => m)
    .sort((a, b) => b.ts.localeCompare(a.ts));
}

function hitText(hit: any): string {
  for (const k of ["text", "content", "value", "snippet", "chunk", "body"]) {
    if (typeof hit?.[k] === "string") return hit[k];
  }
  return "";
}

export async function recallForResident(residentId: string): Promise<RecallResult> {
  await seedMemory();
  if (!remoteConfigured()) return { backend: "local", items: recallLocal(residentId) };

  try {
    const name = getResident(residentId)?.name ?? residentId;
    const data = await remote("/query", {
      query: `${tag(residentId)} ${name}: recent on-call events, decisions, and family wishes`,
      k: 50,
    });
    const seen = new Set<string>();
    const items: MemoryItem[] = [];
    for (const hit of (data?.hits ?? []) as any[]) {
      const text = hitText(hit);
      if (!text.includes(tag(residentId)) || seen.has(text)) continue;
      seen.add(text);
      const tsFromText = text.match(/On-call (\d{4}-\d\d-\d\dT\d\d:\d\d)/)?.[1];
      items.push({
        ts: tsFromText ?? hit.occurredAt ?? "",
        text,
        source: `SurrealDB Agent Memory (${hit.source ?? "memory"})`,
        backend: "agent-memory",
        traceId: data?.trace?.traceId,
      });
    }
    if (!items.length) {
      const sample = data?.hits?.[0] ? Object.keys(data.hits[0]).join(",") : "no hits";
      return { backend: "local", items: recallLocal(residentId), error: `Agent Memory returned no tagged hits (${sample}); showing local copy` };
    }
    return { backend: "agent-memory", items: items.sort((a, b) => b.ts.localeCompare(a.ts)) };
  } catch (err) {
    return { backend: "local", items: recallLocal(residentId), error: (err as Error).message };
  }
}
