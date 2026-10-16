// Claude job (a): extract structured facts from the transcript, each with a verbatim quote.
// Everything Claude returns is validated in code; items whose quote is not in the transcript are dropped.
import { callClaude, type ToolDef } from "./llm.js";
import { CHECKLIST_ITEMS, type ChecklistItem, type ExtractedFacts, type ReportedVitals } from "./types.js";
import type { Segment } from "./calls.js";

const SYSTEM = `You extract facts from a night phone call between a nursing home nurse and an on-call physician.

Rules:
- Extract only what was explicitly said on the call. Never infer, assume, or fill in from medical knowledge.
- Every item must include "quote": a short span copied character for character from the transcript (one sentence or less). Do not paraphrase inside quotes.
- Every number said for a vital sign (blood pressure, heart rate, respiratory rate, temperature, oxygen saturation) goes in vitals_reported, even when it is mentioned alone or as part of the reason for the call.
- Temperature: put the number exactly as said in temp, and set temp_unit to the unit the speaker said (C, F, or not_stated). Never convert units yourself.
- mentioned_checklist: include all 8 items. Set mentioned=true only if the call stated the actual content of that item, so the physician now knows it. Examples: "she's on Eliquis" mentions anticoagulation; "she's a full code" mentions code_status; "at baseline he's only oriented to himself" mentions baseline_mental_status. Comparisons without the content do NOT count: "more confused than usual" does not state the baseline, and "calling again" does not state prior calls. Otherwise mentioned=false and no quote.
- Negation: a denied event ("no fall") has occurred=false; a denied symptom has present=false.
- Do not give clinical advice. Do not suggest a disposition.
- Respond only by calling the record_facts tool, exactly once.`;

const quoted = { type: "string", description: "Verbatim span copied from the transcript." };

const TOOL: ToolDef = {
  name: "record_facts",
  description: "Record the facts stated on the call so far.",
  input_schema: {
    type: "object",
    properties: {
      chief_concern: {
        type: ["object", "null"],
        properties: { text: { type: "string" }, quote: quoted },
        required: ["text", "quote"],
      },
      onset: {
        type: ["object", "null"],
        properties: { text: { type: "string" }, quote: quoted },
        required: ["text", "quote"],
      },
      vitals_reported: {
        type: "array",
        description: "One entry per statement of vital signs. Include only numbers actually said.",
        items: {
          type: "object",
          properties: {
            sbp: { type: "number" }, dbp: { type: "number" }, hr: { type: "number" }, rr: { type: "number" },
            temp: { type: "number", description: "Temperature number exactly as said." },
            temp_unit: { type: "string", enum: ["C", "F", "not_stated"] },
            spo2: { type: "number" },
            o2: { type: "string", description: 'Oxygen delivery as said, e.g. "room air" or "2 L nasal cannula".' },
            quote: quoted,
          },
          required: ["quote"],
        },
      },
      symptoms: {
        type: "array",
        description:
          "Symptoms asked about or reported. Use snake_case names such as head_strike, new_confusion, chest_pain, focal_weakness, facial_droop, speech_change, dyspnea, cough, poor_intake, fever, pain, agitation, lethargy, urinary_change, vomiting, diarrhea. present=false when explicitly denied.",
        items: {
          type: "object",
          properties: { name: { type: "string" }, present: { type: "boolean" }, quote: quoted },
          required: ["name", "present", "quote"],
        },
      },
      events: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["fall", "other"] },
            occurred: { type: "boolean", description: "false when the event is explicitly denied, e.g. \"no fall\"." },
            witnessed: { type: "boolean" },
            head_strike: { type: "boolean" },
            quote: quoted,
          },
          required: ["type", "occurred", "quote"],
        },
      },
      mentioned_checklist: {
        type: "array",
        items: {
          type: "object",
          properties: {
            item: { type: "string", enum: [...CHECKLIST_ITEMS] },
            mentioned: { type: "boolean" },
            quote: quoted,
          },
          required: ["item", "mentioned"],
        },
      },
    },
    required: ["chief_concern", "onset", "vitals_reported", "symptoms", "events", "mentioned_checklist"],
  },
};

// Case, whitespace, and smart-quote insensitive comparison.
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s.,;:!?"']+|[\s.,;:!?"']+$/g, "");
}

function numbersIn(s: string): number[] {
  return (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

export async function extractFacts(segments: Segment[]): Promise<ExtractedFacts> {
  const transcript = segments.map((s) => `${s.speaker && s.speaker !== "unknown" ? s.speaker : "speaker"}: ${s.text}`).join("\n");
  const haystack = norm(segments.map((s) => s.text).join(" \n "));

  const res = await callClaude({
    system: SYSTEM,
    messages: [{ role: "user", content: `Transcript so far:\n\n${transcript}` }],
    tools: [TOOL],
    maxTokens: 4000,
    effort: "low", // extraction is literal copying; low effort keeps the panel near real time
  });
  const call = res.toolCalls.find((t) => t.name === "record_facts");
  if (!call) throw new Error(`model did not call record_facts (stop: ${res.stopReason})`);
  const raw = call.input as any;

  const dropped: ExtractedFacts["dropped"] = [];
  const inTranscript = (quote: unknown, kind: string): quote is string => {
    if (typeof quote === "string" && norm(quote) && haystack.includes(norm(quote))) return true;
    dropped.push({ kind, quote: String(quote ?? ""), reason: "quote not found in transcript" });
    return false;
  };

  const single = (v: any, kind: string) =>
    v && typeof v.text === "string" && inTranscript(v.quote, kind) ? { text: v.text, quote: v.quote } : null;

  // Vitals: the quote must be in the transcript AND each number must appear in its own quote.
  const vitals_reported: ReportedVitals[] = [];
  for (const v of Array.isArray(raw.vitals_reported) ? raw.vitals_reported : []) {
    if (!inTranscript(v?.quote, "vitals")) continue;
    const nums = numbersIn(v.quote);
    const kept: ReportedVitals = { quote: v.quote };
    const has = (key: string, value: unknown): value is number => {
      if (typeof value !== "number") return false;
      if (nums.includes(value)) return true;
      dropped.push({ kind: `vitals.${key}`, quote: v.quote, reason: `value ${value} not in quote` });
      return false;
    };
    for (const key of ["sbp", "dbp", "hr", "rr", "spo2"] as const) if (has(key, v[key])) kept[key] = v[key];
    // Unit decided in code: stated F, or an unstated value of 50 or more, is Fahrenheit.
    if (has("temp", v.temp)) {
      if (v.temp_unit === "F" || (v.temp_unit !== "C" && v.temp >= 50)) kept.temp_f = v.temp;
      else kept.temp_c = v.temp;
    }
    if (typeof v.o2 === "string") kept.o2 = v.o2;
    // Fahrenheit is converted here in code, never by the model.
    if (kept.temp_f !== undefined) kept.temp_c = Math.round(((kept.temp_f - 32) * 5) / 9 * 10) / 10;
    if (Object.keys(kept).length > 1) vitals_reported.push(kept);
  }

  const symptoms = (Array.isArray(raw.symptoms) ? raw.symptoms : [])
    .filter((s: any) => typeof s?.name === "string" && typeof s?.present === "boolean" && inTranscript(s.quote, `symptom.${s.name}`))
    .map((s: any) => ({ name: s.name, present: s.present, quote: s.quote }));

  const events = (Array.isArray(raw.events) ? raw.events : [])
    // Denied events ("no fall") are dropped in code: only events that occurred can drive rules.
    .filter((e: any) => (e?.type === "fall" || e?.type === "other") && e?.occurred !== false && inTranscript(e.quote, `event.${e.type}`))
    .map((e: any) => ({ type: e.type, witnessed: e.witnessed, head_strike: e.head_strike, quote: e.quote }));

  // A "mentioned" claim without a verifiable quote counts as NOT mentioned, so the chart fact still surfaces.
  const claimed = new Map<ChecklistItem, string>();
  for (const m of Array.isArray(raw.mentioned_checklist) ? raw.mentioned_checklist : []) {
    if (!CHECKLIST_ITEMS.includes(m?.item) || m?.mentioned !== true) continue;
    if (inTranscript(m.quote, `checklist.${m.item}`)) claimed.set(m.item, m.quote);
  }
  const mentioned_checklist = CHECKLIST_ITEMS.map((item) =>
    claimed.has(item) ? { item, mentioned: true, quote: claimed.get(item) } : { item, mentioned: false },
  );

  if (dropped.length) console.log(`[extract] dropped ${dropped.length}:`, dropped.map((d) => `${d.kind} (${d.reason})`).join("; "));

  return {
    chief_concern: single(raw.chief_concern, "chief_concern"),
    onset: single(raw.onset, "onset"),
    vitals_reported,
    symptoms,
    events,
    mentioned_checklist,
    dropped,
  };
}
