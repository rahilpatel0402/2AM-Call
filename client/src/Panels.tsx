import { useState, type ReactNode } from "react";
import type { CoveredItem, ExtractedFacts, PriorCallMemory, ReportedVitals, Segment, UnsaidItem } from "./types";

// ---------- shared card chrome ----------

const ICONS: Record<string, ReactNode> = {
  flag: <path d="M5 21V4m0 0h11l-2 4 2 4H5" />,
  alert: <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />,
  ear: <path d="M6 8.5a6 6 0 1 1 12 0c0 6-6 6-6 10a3 3 0 0 1-6 0M10 8.5a2 2 0 1 1 4 0" />,
  pulse: <path d="M3 12h4l3 8 4-16 3 8h4" />,
  building: <path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16m0-10h2a2 2 0 0 1 2 2v8M8 7h4m-4 4h4m-4 4h4M2 21h20" />,
  history: <path d="M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5m4-1v5l3 2" />,
  search: <path d="m21 21-4.3-4.3M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z" />,
  phone: <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />,
};

export function Icon({ name, size = 20 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name]}
    </svg>
  );
}

export function Card({
  title, icon, tone = "neutral", meta, className = "", children,
}: {
  title: string; icon: keyof typeof ICONS; tone?: "neutral" | "red" | "amber" | "green" | "blue";
  meta?: ReactNode; className?: string; children: ReactNode;
}) {
  return (
    <section className={`card tone-${tone} ${className}`}>
      <header className="card-head">
        <span className="card-icon"><Icon name={icon} /></span>
        <h2>{title}</h2>
        {meta && <span className="card-meta">{meta}</span>}
      </header>
      <div className="card-body">{children}</div>
    </section>
  );
}

// ---------- transcript ----------

export function Transcript({ segments, partial, hint }: { segments: Segment[]; partial?: string; hint?: string }) {
  return (
    <div className="bubbles">
      {!segments.length && !partial && <p className="empty">{hint}</p>}
      {segments.map((s) => (
        <div key={s.id} className={`bubble bubble-${s.speaker ?? "unknown"}`}>
          {s.speaker && s.speaker !== "unknown" && <span className="who">{s.speaker === "nurse" ? "Nurse" : "Physician"}</span>}
          <span>{s.text}</span>
        </div>
      ))}
      {partial && <div className="bubble bubble-partial">{partial}</div>}
    </div>
  );
}

// ---------- not yet mentioned / covered ----------

const VISIBLE_UNSAID = 5;

export function UnsaidCard({
  items, covered, started, ended,
}: { items: UnsaidItem[]; covered: CoveredItem[]; started: boolean; ended: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? items : items.slice(0, VISIBLE_UNSAID);
  const title = ended ? "Never mentioned on this call" : "Not yet mentioned";
  return (
    <Card
      title={title}
      icon="alert"
      tone="amber"
      className="unsaid"
      meta={started && <span className="count count-amber">{items.length}</span>}
    >
      {!started && <p className="empty">Critical chart context the caller has not mentioned will appear here, with its source.</p>}
      {started && !items.length && <p className="empty">Every checklist item has been covered on the call.</p>}
      <ul className="items">
        {shown.map((u) => (
          <li key={u.item} className="item item-amber">
            <div className="item-label">{u.label}</div>
            <div className="item-value">{u.value}</div>
            <div className="source">Source: {u.source.label}</div>
          </li>
        ))}
      </ul>
      {items.length > VISIBLE_UNSAID && (
        <button className="link-btn" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Show fewer" : `Show ${items.length - VISIBLE_UNSAID} more`}
        </button>
      )}
      {covered.length > 0 && (
        <div className="covered">
          <div className="covered-title">Covered on call</div>
          {covered.map((c) => (
            <div key={c.item} className="covered-item">
              <span className="check">✓</span>
              <span className="covered-label">{c.label}</span>
              <span className="quote">"{c.quote}"</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------- heard on call ----------

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

export function HeardCard({ facts, started, processing }: { facts: ExtractedFacts | null; started: boolean; processing: boolean }) {
  const meta = processing ? <span className="analyzing">Analyzing</span> : null;
  if (!facts) {
    return (
      <Card title="Heard on call" icon="ear" tone="blue" meta={meta}>
        <p className="empty">{started ? "Listening." : "Vitals, symptoms, and events stated on the call, each linked to its quote."}</p>
      </Card>
    );
  }
  const v = mergeVitals(facts.vitals_reported);
  const tiles: { label: string; value: string; quote: string }[] = [];
  if (v.sbp) tiles.push({ label: "BP", value: `${v.sbp.value}${v.dbp ? `/${v.dbp.value}` : ""}`, quote: v.sbp.quote });
  if (v.hr) tiles.push({ label: "HR", value: String(v.hr.value), quote: v.hr.quote });
  if (v.rr) tiles.push({ label: "RR", value: String(v.rr.value), quote: v.rr.quote });
  if (v.spo2) tiles.push({ label: "SpO2", value: `${v.spo2.value}%`, quote: v.spo2.quote });
  if (v.temp_c) tiles.push({ label: "Temp", value: `${Number(v.temp_c.value).toFixed(1)}°C`, quote: v.temp_c.quote });

  const present = facts.symptoms.filter((s) => s.present);
  const denied = facts.symptoms.filter((s) => !s.present);

  return (
    <Card title="Heard on call" icon="ear" tone="blue" meta={meta}>
      {facts.chief_concern && (
        <p className="concern" title={`"${facts.chief_concern.quote}"`}>{facts.chief_concern.text}</p>
      )}
      {tiles.length > 0 && (
        <div className="tiles">
          {tiles.map((t) => (
            <div key={t.label} className="tile" title={`"${t.quote}"`}>
              <div className="tile-label">{t.label}</div>
              <div className="tile-value">{t.value}</div>
            </div>
          ))}
          {v.o2 && <div className="tile tile-text" title={`"${v.o2.quote}"`}><div className="tile-label">O2</div><div className="tile-value small">{v.o2.value}</div></div>}
        </div>
      )}
      {facts.events.map((e, i) => (
        <p key={i} className="fact" title={`"${e.quote}"`}>
          <strong>{e.type === "fall" ? "Fall" : "Event"}</strong>
          {e.witnessed === false && " · unwitnessed"}
          {e.witnessed === true && " · witnessed"}
          {e.head_strike === true && " · head strike"}
        </p>
      ))}
      {facts.onset && <p className="fact" title={`"${facts.onset.quote}"`}><strong>Onset</strong> {facts.onset.text}</p>}
      {(present.length > 0 || denied.length > 0) && (
        <div className="chips">
          {present.map((s) => <span key={s.name} className="chip chip-present" title={`"${s.quote}"`}>{pretty(s.name)}</span>)}
          {denied.map((s) => <span key={s.name} className="chip chip-denied" title={`"${s.quote}"`}>no {pretty(s.name)}</span>)}
        </div>
      )}
      <p className="source">
        Each item is quoted from the transcript (hover to view).
        {facts.dropped.length > 0 && ` ${facts.dropped.length} unverified item(s) dropped.`}
      </p>
    </Card>
  );
}

// ---------- prior calls (SurrealDB Agent Memory) ----------

function formatTs(ts: string) {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function PriorCallsCard({ items, backend, started }: { items: PriorCallMemory[]; backend: string | null; started: boolean }) {
  return (
    <Card title="Remembered from prior night calls" icon="history" meta={started && items.length > 0 && <span className="count">{items.length}</span>}>
      {!started && <p className="empty">Recalled from SurrealDB Agent Memory when a call starts.</p>}
      {started && backend === null && <p className="empty">Recalling.</p>}
      {started && backend !== null && !items.length && <p className="empty">No prior night calls on record.</p>}
      <ul className="items">
        {items.map((m) => {
          const body = m.text.replace(/^\[resident:[^\]]+\]\s*On-call \S+ /, "");
          return (
            <li key={m.text} className="item">
              <div className="item-label">{formatTs(m.ts)}</div>
              <div className="item-value">{body}</div>
              <div className="source">Source: {m.source}</div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
