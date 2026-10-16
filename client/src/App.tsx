import { useEffect, useRef, useState } from "react";
import { CommitStrategy, useScribe } from "@elevenlabs/react";
import type { CallState, ResidentDetail, ResidentSummary } from "./types";
import { AskCard, Card, FacilityCard, HeardCard, Icon, PriorCallsCard, RedFlagsCard, Transcript, UnsaidCard, VitalsCard } from "./Panels";

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

function useElapsed(startedAt: number | undefined, running: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  if (!startedAt) return "00:00";
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const initials = (name: string) => name.split(" ").map((p) => p[0]).join("").slice(0, 2);

export default function App() {
  const [residents, setResidents] = useState<ResidentSummary[]>([]);
  const [residentId, setResidentId] = useState("res_margaret");
  const [detail, setDetail] = useState<ResidentDetail | null>(null);
  const [call, setCall] = useState<CallState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const callIdRef = useRef<string | null>(null);
  const [audioOn, setAudioOn] = useState(true);
  const [voicing, setVoicing] = useState(false);
  const voiceRun = useRef(0); // increments to cancel an in-flight voiced replay
  const audioEl = useRef<HTMLAudioElement | null>(null);

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

  useEffect(() => {
    setDetail(null);
    fetch(`/api/residents/${residentId}`).then((r) => r.json()).then(setDetail).catch(() => {});
  }, [residentId]);

  // One SSE stream per call; the server pushes the full CallState on every change.
  useEffect(() => {
    if (!call?.callId) return;
    const es = new EventSource(`/api/calls/${call.callId}/stream`);
    es.onmessage = (ev) => setCall(JSON.parse(ev.data));
    return () => es.close();
  }, [call?.callId]);

  async function newCall(): Promise<CallState> {
    const state = await postJson<CallState>("/api/calls", { residentId });
    callIdRef.current = state.callId;
    setCall(state);
    return state;
  }

  function stopVoice() {
    voiceRun.current++;
    audioEl.current?.pause();
    audioEl.current = null;
    setVoicing(false);
  }

  // Voiced replay: each line is played in the nurse or physician voice (ElevenLabs TTS) and
  // posted to the call as it starts playing, so the panels react while the room hears the call.
  async function voicedReplay(callId: string, script: string) {
    const run = ++voiceRun.current;
    setVoicing(true);
    await postJson(`/api/calls/${callId}/replaying`, { on: true });
    const lines: { speaker: "nurse" | "doctor"; text: string; delayMs: number }[] = await fetch(`/api/scripts/${script}`).then((r) => r.json());
    const clip = (i: number) => {
      const a = new Audio(`/api/tts/${script}/${i}`);
      a.preload = "auto";
      return a;
    };
    let next = clip(0);
    for (let i = 0; i < lines.length; i++) {
      if (voiceRun.current !== run) return;
      const audio = next;
      if (i + 1 < lines.length) next = clip(i + 1);
      audioEl.current = audio;
      postJson(`/api/calls/${callId}/segments`, { text: lines[i].text, speaker: lines[i].speaker }).catch(() => {});
      try {
        await audio.play();
        await new Promise<void>((resolve) => {
          audio.onended = () => resolve();
          audio.onerror = () => resolve();
        });
      } catch {
        await new Promise((r) => setTimeout(r, lines[i].delayMs)); // audio blocked or failed: keep the text pacing
      }
      await new Promise((r) => setTimeout(r, 350)); // natural pause between speakers
    }
    if (voiceRun.current !== run) return;
    setVoicing(false);
    await postJson(`/api/calls/${callId}/replaying`, { on: false }).catch(() => {});
  }

  async function startReplay() {
    setError(null);
    try {
      if (scribe.isConnected) scribe.disconnect();
      stopVoice();
      const state = await newCall();
      const script = residentId.replace("res_", "");
      if (audioOn) void voicedReplay(state.callId, script).catch((e) => setError(`Voiced replay: ${e.message}`));
      else await postJson(`/api/calls/${state.callId}/replay`, { script });
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
    stopVoice();
    if (scribe.isConnected) scribe.disconnect();
    if (call) await postJson(`/api/calls/${call.callId}/end`).catch(() => {});
  }

  const r = detail?.resident;
  const callActive = call?.status === "live";
  const ended = call?.status === "ended";
  const elapsed = useElapsed(call?.startedAt, !!callActive);
  const clock = call ? new Date(call.clockStart).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "";
  const source = scribe.isConnected ? "Live microphone" : call?.replaying ? (voicing ? "Replay of recorded call · audio" : "Replay of recorded call") : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Icon name="phone" size={22} /></span>
          <div>
            <div className="brand-name">The 2 AM Call</div>
            <div className="brand-sub">AI co-pilot for the night call from a nursing home</div>
          </div>
        </div>
        <span className="synthetic">SYNTHETIC DATA</span>
        <div className="controls">
          <select
            className="select"
            aria-label="Resident"
            value={residentId}
            onChange={(e) => {
              setResidentId(e.target.value);
              if (scribe.isConnected) scribe.disconnect();
              stopVoice();
              callIdRef.current = null;
              setCall(null);
            }}
          >
            {residents.map((x) => (
              <option key={x.id} value={x.id}>{x.name} · Rm {x.room}</option>
            ))}
          </select>
          <label className="audio-toggle" title="Play the call audio during replay (ElevenLabs voices)">
            <input type="checkbox" checked={audioOn} onChange={(e) => setAudioOn(e.target.checked)} /> Audio
          </label>
          <button className="btn btn-light" onClick={startReplay} disabled={(!!call?.replaying || voicing) && callActive}>Replay</button>
          <button className={`btn ${scribe.isConnected ? "btn-danger" : "btn-light"}`} onClick={toggleLive}>
            {scribe.isConnected ? "Stop live" : "Live"}
          </button>
        </div>
      </header>

      <div className="patient-banner">
        <div className="avatar">{r ? initials(r.name) : ""}</div>
        <div className="patient-main">
          <div className="patient-name">{r?.name ?? "Loading"}</div>
          {r && (
            <div className="patient-meta">
              <span>{r.age} {r.sex === "F" ? "Female" : "Male"}</span>
              <span>Room {r.room}</span>
              <span>{detail?.facility.name}</span>
              <span>Primary doctor {r.pcp}</span>
            </div>
          )}
        </div>
        <div className={`call-status ${callActive ? "is-live" : ended ? "is-ended" : ""}`}>
          {callActive ? (
            <>
              <span className="pulse" />
              <div>
                <div className="call-status-title">Call in progress · {clock} · {elapsed}</div>
                {source && <div className="call-status-sub">{source}</div>}
              </div>
            </>
          ) : ended ? (
            <div className="call-status-title">Call ended</div>
          ) : (
            <div className="call-status-title">No active call</div>
          )}
        </div>
      </div>

      {error && <div className="error-bar">{error}</div>}
      {call?.pipelineError && <div className="error-bar">Analysis error: {call.pipelineError}</div>}

      <main className="layout">
        <Card title="Call transcript" icon="phone" className="transcript-card">
          <Transcript
            segments={call?.segments ?? []}
            partial={scribe.isConnected ? scribe.partialTranscript : undefined}
            hint="Choose a resident, then start a Replay or a Live call."
          />
        </Card>

        <div className="panels">
          <RedFlagsCard flags={call?.redFlags ?? []} goalsNote={call?.goalsNote ?? null} started={!!call?.facts} />

          <div className="row row-primary">
            <UnsaidCard items={call?.facts ? call.unsaid : []} covered={call?.covered ?? []} started={!!call?.facts} ended={!!ended} />
            <HeardCard facts={call?.facts ?? null} started={!!call} processing={!!call?.processing} />
          </div>

          <div className="row">
            <VitalsCard scores={call?.scores ?? null} />
            <FacilityCard items={call?.feasibility ?? []} started={!!call?.facts} />
          </div>

          <div className="row">
            <PriorCallsCard items={call?.priorCalls ?? []} backend={call?.memoryBackend ?? null} started={!!call} note={call?.priorCallsNote} />
            <AskCard residentId={residentId} firstName={r?.name.split(" ")[0] ?? "this resident"} />
          </div>
        </div>
      </main>

      <footer className="actionbar">
        <button className="btn btn-outline" onClick={endCurrentCall} disabled={!callActive}>End call</button>
        <span className="disclaimer">Decision support only. The physician makes every disposition decision.</span>
      </footer>
    </div>
  );
}
