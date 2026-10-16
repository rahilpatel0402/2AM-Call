import { useState, type ReactNode } from "react";
import type { CoveredItem, Delta, ExtractedFacts, FeasibilityItem, News2, PriorCallMemory, RedFlag, ReportedVitals, Scores, Segment, UnsaidItem } from "./types";

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

export function PriorCallsCard({ items, backend, started, note }: { items: PriorCallMemory[]; backend: string | null; started: boolean; note?: string | null }) {
  return (
    <Card title="Remembered from prior night calls" icon="history" meta={started && items.length > 0 && <span className="count">{items.length}</span>}>
      {note && <div className="repeat-note">{note}</div>}
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

// ---------- red flags (deterministic rules) ----------

export function RedFlagsCard({ flags, goalsNote, started }: { flags: RedFlag[]; goalsNote: string | null; started: boolean }) {
  const firing = flags.length > 0;
  return (
    <section className={`card flags ${firing ? "flags-on" : started ? "flags-clear" : ""}`}>
      <header className="card-head">
        <span className="card-icon"><Icon name="flag" /></span>
        <h2>{firing ? `Red flags · ${flags.length}` : "Red flags"}</h2>
        {firing && <span className="flags-banner">Consider urgent evaluation / transfer. Physician decision.</span>}
      </header>
      <div className="card-body">
        {!started && <p className="empty">Fixed clinical rules run on every update. The AI cannot add, remove, or soften a red flag.</p>}
        {started && !firing && <p className="no-flags">No rule based red flags at this point in the call.</p>}
        {firing && (
          <div className="flag-grid">
            {flags.map((f) => (
              <div key={f.id} className="flag">
                <div className="flag-title">{f.title}</div>
                <div className="flag-why">{f.why}</div>
                <ul className="flag-evidence">
                  {f.evidence.map((e) => <li key={e}>{e}</li>)}
                </ul>
              </div>
            ))}
          </div>
        )}
        {started && goalsNote && <div className="goals-note">{goalsNote}</div>}
      </div>
    </section>
  );
}

// ---------- vitals vs baseline + NEWS2 ----------

const BAND_LABEL: Record<News2["band"], string> = { low: "Low", "low-medium": "Low-medium", medium: "Medium", high: "High" };

function fmt(key: string, n: number) {
  return key === "temp_c" ? n.toFixed(1) : String(Math.round(n * 10) / 10);
}

export function VitalsCard({ scores }: { scores: Scores | null }) {
  if (!scores) {
    return (
      <Card title="Vitals vs baseline · NEWS2" icon="pulse">
        <p className="empty">Tonight's vitals against this resident's own 14 day baseline, with NEWS2 computed in code.</p>
      </Card>
    );
  }
  const { news2, deltas, baseline } = scores;
  // Flag a delta as notable when it moves meaningfully off this resident's own baseline.
  const notable = (d: Delta) =>
    (d.key === "sbp" && Math.abs(d.diff) >= 20) || (d.key === "hr" && Math.abs(d.diff) >= 15) ||
    (d.key === "rr" && Math.abs(d.diff) >= 4) || (d.key === "spo2" && d.diff <= -3) || (d.key === "temp_c" && Math.abs(d.diff) >= 1);
  return (
    <Card title="Vitals vs baseline · NEWS2" icon="pulse">
      <div className={`news2 band-${news2.band}`}>
        <div className="news2-score">{news2.total}</div>
        <div>
          <div className="news2-label">NEWS2 · {BAND_LABEL[news2.band]}</div>
          <div className="news2-parts">
            {news2.parts.filter((p) => p.points > 0).map((p) => `${p.param} +${p.points}`).join(" · ") || "All parameters 0"}
          </div>
          {!news2.complete && <div className="source">Some parameters use last charted values.</div>}
        </div>
      </div>
      <table className="deltas">
        <thead>
          <tr><th></th><th>Tonight</th><th>Usual</th><th>Change</th></tr>
        </thead>
        <tbody>
          {deltas.map((d) => (
            <tr key={d.key} className={notable(d) ? "notable" : ""}>
              <td className="d-label">{d.label}</td>
              <td className="d-now">{fmt(d.key, d.current)}{d.from === "chart" && <span className="from-chart" title="Not stated on the call; last charted value">chart</span>}</td>
              <td>{fmt(d.key, d.baseline)}</td>
              <td className="d-diff">{d.diff > 0 ? "▲" : d.diff < 0 ? "▼" : ""} {d.diff === 0 ? "0" : fmt(d.key, Math.abs(d.diff))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="source">Usual = {baseline.source}.</p>
    </Card>
  );
}

// ---------- facility capability tonight ----------

export function FacilityCard({ items, started }: { items: FeasibilityItem[]; started: boolean }) {
  const can = items.filter((i) => i.available);
  const cannot = items.filter((i) => !i.available);
  return (
    <Card title="Facility capability tonight" icon="building">
      {!started && <p className="empty">What this facility can and cannot do overnight, matched to tonight's problem.</p>}
      {started && !items.length && <p className="empty">Capabilities appear as the problem becomes clear.</p>}
      {cannot.length > 0 && (
        <div className="cap-group">
          <div className="cap-title cap-no">Cannot tonight</div>
          {cannot.map((i) => (
            <div key={i.capability} className="cap cap-no-row">
              <span className="cap-mark">✕</span>
              <div><strong>{i.capability}</strong> <span className="cap-detail">{i.detail}</span><div className="source">for: {i.need}</div></div>
            </div>
          ))}
        </div>
      )}
      {can.length > 0 && (
        <div className="cap-group">
          <div className="cap-title cap-yes">Can tonight</div>
          {can.map((i) => (
            <div key={i.capability} className="cap">
              <span className="cap-mark cap-mark-yes">✓</span>
              <div><strong>{i.capability}</strong> <span className="cap-detail">{i.detail}</span><div className="source">for: {i.need}</div></div>
            </div>
          ))}
        </div>
      )}
      {items.length > 0 && <p className="source">Source: facility overnight capability profile. Shown for information, not as a recommendation.</p>}
    </Card>
  );
}
