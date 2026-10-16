import { useState } from "react";
import type { ExtractedFacts, PriorCallMemory, ReportedVitals, UnsaidItem } from "./types";

const VISIBLE_UNSAID = 5;

export function UnsaidCard({ items, started }: { items: UnsaidItem[]; started: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? items : items.slice(0, VISIBLE_UNSAID);
  return (
    <div className="card unsaid">
      <h2>What wasn't said</h2>
      {!started && <p className="muted">Waiting for the call.</p>}
      {started && !items.length && <p className="muted">Everything on the checklist was mentioned.</p>}
      <ul className="unsaid-list">
        {shown.map((u) => (
          <li key={u.item} className="unsaid-item">
            <div>
              <strong>{u.label}:</strong> {u.value}
            </div>
            <div className="source">source: {u.source.label}</div>
          </li>
        ))}
      </ul>
      {items.length > VISIBLE_UNSAID && (
        <button className="link-btn" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Show less" : `${items.length - VISIBLE_UNSAID} more`}
        </button>
      )}
    </div>
  );
}

// Latest value per field across everything reported on the call.
function mergeVitals(list: ReportedVitals[]) {
  const out: Partial<Record<keyof ReportedVitals, { value: number | string; quote: string }>> = {};
  for (const v of list) {
    for (const k of ["sbp", "dbp", "hr", "rr", "temp_c", "spo2", "o2"] as const) {
      if (v[k] !== undefined) out[k] = { value: v[k]!, quote: v.quote };
    }
  }
  return out;
}

const pretty = (name: string) => name.replace(/_/g, " ");

export function HeardCard({ facts, started }: { facts: ExtractedFacts | null; started: boolean }) {
  if (!facts) {
    return (
      <div className="card heard">
        <h2>Heard on call</h2>
        <p className="muted">{started ? "Listening." : "Waiting for the call."}</p>
      </div>
    );
  }
  const v = mergeVitals(facts.vitals_reported);
  const vitalParts: { text: string; quote: string }[] = [];
  if (v.sbp) vitalParts.push({ text: `BP ${v.sbp.value}${v.dbp ? `/${v.dbp.value}` : ""}`, quote: v.sbp.quote });
  if (v.hr) vitalParts.push({ text: `HR ${v.hr.value}`, quote: v.hr.quote });
  if (v.rr) vitalParts.push({ text: `RR ${v.rr.value}`, quote: v.rr.quote });
  if (v.spo2) vitalParts.push({ text: `SpO2 ${v.spo2.value}%${v.o2 ? ` ${v.o2.value}` : ""}`, quote: v.spo2.quote });
  if (v.temp_c) vitalParts.push({ text: `Temp ${Number(v.temp_c.value).toFixed(1)} C`, quote: v.temp_c.quote });

  const present = facts.symptoms.filter((s) => s.present);
  const denied = facts.symptoms.filter((s) => !s.present);

  return (
    <div className="card heard">
      <h2>Heard on call</h2>
      {facts.chief_concern && (
        <p className="fact" title={`"${facts.chief_concern.quote}"`}>
          <strong>Concern:</strong> {facts.chief_concern.text}
        </p>
      )}
      {facts.onset && (
        <p className="fact" title={`"${facts.onset.quote}"`}>
          <strong>Onset:</strong> {facts.onset.text}
        </p>
      )}
      {facts.events.map((e, i) => (
        <p key={i} className="fact" title={`"${e.quote}"`}>
          <strong>Event:</strong> {e.type === "fall" ? "Fall" : "Other"}
          {e.witnessed === false && ", unwitnessed"}
          {e.witnessed === true && ", witnessed"}
          {e.head_strike === true && ", head strike"}
        </p>
      ))}
      {vitalParts.length > 0 && (
        <p className="fact vitals-line">
          {vitalParts.map((p) => (
            <span key={p.text} className="vital" title={`"${p.quote}"`}>
              {p.text}
            </span>
          ))}
        </p>
      )}
      {present.length > 0 && (
        <div className="chips">
          {present.map((s) => (
            <span key={s.name} className="chip chip-present" title={`"${s.quote}"`}>
              {pretty(s.name)}
            </span>
          ))}
        </div>
      )}
      {denied.length > 0 && (
        <div className="chips">
          {denied.map((s) => (
            <span key={s.name} className="chip chip-denied" title={`"${s.quote}"`}>
              no {pretty(s.name)}
            </span>
          ))}
        </div>
      )}
      <p className="source">Every item is quoted from the transcript. Hover to see the quote.</p>
      {facts.dropped.length > 0 && (
        <p className="source">{facts.dropped.length} unverified item(s) dropped (quote not in transcript).</p>
      )}
    </div>
  );
}

export function PriorCallsCard({ items, backend, started }: { items: PriorCallMemory[]; backend: string | null; started: boolean }) {
  return (
    <div className="card">
      <h2>Remembered from prior night calls</h2>
      {!started && <p className="muted">Waiting for the call.</p>}
      {started && backend === null && <p className="muted">Recalling.</p>}
      {started && backend !== null && !items.length && <p className="muted">No prior night calls on record.</p>}
      <ul className="unsaid-list">
        {items.map((m) => (
          <li key={m.text} className="unsaid-item">
            <div>{m.text.replace(/^\[resident:[^\]]+\]\s*/, "")}</div>
            <div className="source">source: {m.source}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
