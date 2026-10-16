import { useEffect, useRef, useState } from "react";
import { CommitStrategy, useScribe } from "@elevenlabs/react";
import type { CallState, ResidentSummary } from "./types";
import { HeardCard, PriorCallsCard, UnsaidCard } from "./Panels";

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export default function App() {
  const [residents, setResidents] = useState<ResidentSummary[]>([]);
  const [residentId, setResidentId] = useState("res_margaret");
  const [call, setCall] = useState<CallState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const callIdRef = useRef<string | null>(null);
  const transcriptEnd = useRef<HTMLDivElement>(null);

  const scribe = useScribe({
    modelId: "scribe_v2_realtime",
    commitStrategy: CommitStrategy.VAD,
    languageCode: "en",
    onCommittedTranscript: (data) => {
      const text = data.text?.trim();
      if (text && callIdRef.current) {
        postJson(`/api/calls/${callIdRef.current}/segments`, { text, speaker: "unknown" }).catch((e) => setError(e.message));
      }
    },
    onError: (e) => setError(`Live transcription error: ${e instanceof Error ? e.message : "connection problem"}`),
    onAuthError: (d) => setError(`Live transcription auth error: ${d.error}`),
  });

  useEffect(() => {
    fetch("/api/residents").then((r) => r.json()).then(setResidents).catch((e) => setError(e.message));
  }, []);

  // One SSE stream per call; the server pushes the full CallState on every change.
  useEffect(() => {
    if (!call?.callId) return;
    const es = new EventSource(`/api/calls/${call.callId}/stream`);
    es.onmessage = (ev) => setCall(JSON.parse(ev.data));
    return () => es.close();
  }, [call?.callId]);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [call?.segments.length, scribe.partialTranscript]);

  async function newCall(): Promise<CallState> {
    const state = await postJson<CallState>("/api/calls", { residentId });
    callIdRef.current = state.callId;
    setCall(state);
    return state;
  }

  async function startReplay() {
    setError(null);
    try {
      if (scribe.isConnected) scribe.disconnect();
      const state = await newCall();
      await postJson(`/api/calls/${state.callId}/replay`, { script: residentId.replace("res_", "") });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toggleLive() {
    setError(null);
    if (scribe.isConnected) {
      scribe.disconnect();
      return;
    }
    try {
      if (!call || call.status === "ended" || call.replaying || call.residentId !== residentId) await newCall();
      const { token } = await fetch("/api/scribe-token").then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error);
        return d;
      });
      await scribe.connect({ token, microphone: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      setError(`Could not start live mode: ${(e as Error).message}`);
    }
  }

  async function endCurrentCall() {
    if (scribe.isConnected) scribe.disconnect();
    if (call) await postJson(`/api/calls/${call.callId}/end`).catch(() => {});
  }

  const resident = residents.find((r) => r.id === residentId);
  const callActive = call?.status === "live";

  return (
    <div className="app">
      <header className="header">
        <span className="title">The 2 AM Call</span>
        <span className="divider">|</span>
        <span className="badge">SYNTHETIC DATA</span>
        <div className="controls">
          <label className="resident-picker">
            Resident
            <select
              value={residentId}
              onChange={(e) => {
                setResidentId(e.target.value);
                if (scribe.isConnected) scribe.disconnect();
                callIdRef.current = null;
                setCall(null);
              }}
            >
              {residents.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}, {r.age}{r.sex}, Rm {r.room}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" onClick={startReplay} disabled={call?.replaying && callActive}>
            Replay
          </button>
          <button className={`btn ${scribe.isConnected ? "btn-live" : ""}`} onClick={toggleLive}>
            {scribe.isConnected ? "Stop live" : "Live"}
          </button>
        </div>
      </header>

      {error && <div className="error-bar">{error}</div>}

      <main className="layout">
        <section className="card transcript">
          <h2>
            Live transcript
            {callActive && (scribe.isConnected || call?.replaying) && <span className="live-dot">LIVE</span>}
            {call?.processing && <span className="analyzing">analyzing</span>}
          </h2>
          {call?.pipelineError && <p className="pipeline-error">Analysis error: {call.pipelineError}</p>}
          {!call && <p className="muted">Choose a resident, then click Replay or Live.</p>}
          {call && resident && <p className="muted small">Call about {resident.name}</p>}
          <div className="lines">
            {call?.segments.map((s) => (
              <p key={s.id} className={`line line-${s.speaker ?? "unknown"}`}>
                {s.speaker && s.speaker !== "unknown" && <span className="speaker">{s.speaker}:</span>} {s.text}
              </p>
            ))}
            {scribe.isConnected && scribe.partialTranscript && <p className="line partial">{scribe.partialTranscript}</p>}
            <div ref={transcriptEnd} />
          </div>
        </section>

        <section className="panels">
          <div className="card red-flags">
            <h2>Red flags</h2>
            <p className="muted">No rule based red flags yet.</p>
          </div>
          <div className="row">
            <UnsaidCard items={call?.facts ? call.unsaid : []} started={!!call?.facts} />
            <HeardCard facts={call?.facts ?? null} started={!!call} />
          </div>
          <div className="row">
            <div className="card">
              <h2>Vs baseline + NEWS2</h2>
              <p className="muted">Waiting for vitals.</p>
            </div>
            <div className="card">
              <h2>Facility tonight</h2>
              <p className="muted">Waiting for the call.</p>
            </div>
          </div>
          <div className="row">
            <PriorCallsCard items={call?.priorCalls ?? []} backend={call?.memoryBackend ?? null} started={!!call} />
            <div className="card">
              <h2>Ask the chart</h2>
              <p className="muted">Available during a call.</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <button className="btn" onClick={endCurrentCall} disabled={!callActive}>
          End call
        </button>
        <span className="muted small">The physician makes every disposition decision.</span>
      </footer>
    </div>
  );
}
