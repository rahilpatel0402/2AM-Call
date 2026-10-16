// ElevenLabs Text to Speech for voiced replay: each script line spoken in the nurse's or physician's voice.
// Audio is generated once per line and cached on disk, so the demo plays instantly and offline after warm-up.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";
import { getResident, getScript } from "./db.js";
import { closingLines } from "./closing.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(here, "../.tts-cache");
const MODEL_ID = "eleven_multilingual_v2";

// Voice casting. Linda (Margaret, Dorothy) and Ray (Joseph) are the night nurses; one on-call physician.
const VOICES = {
  linda: "Nhs7eitvQWFTQBsf0yiT", // Sarah - Approachable and Informative
  ray: "iP95p4xoKVk53GoZ742B", // Chris - Charming, Down-to-Earth
  physician: "cjVigY5qzO86Huf0OWal", // Eric - Smooth, Trustworthy
};

function voiceFor(script: string, speaker: "nurse" | "doctor"): string {
  if (speaker === "doctor") return VOICES.physician;
  return script === "joseph" ? VOICES.ray : VOICES.linda;
}

function cachePath(voiceId: string, text: string): string {
  const key = crypto.createHash("sha1").update(`${MODEL_ID}|${voiceId}|${text}`).digest("hex").slice(0, 16);
  return path.join(CACHE_DIR, `${key}.mp3`);
}

async function synthesize(voiceId: string, text: string, previous?: string, next?: string): Promise<Buffer> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": env("ELEVENLABS_API_KEY"), "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
      previous_text: previous,
      next_text: next,
      voice_settings: { stability: 0.55, similarity_boost: 0.75, speed: 1.0 },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

// Returns the mp3 for one line of a scripted call, generating and caching it on first use.
export async function lineAudio(script: string, index: number): Promise<Buffer> {
  const lines = getScript(script);
  const line = lines?.[index];
  if (!lines || !line) throw new Error(`no line ${index} in script "${script}"`);
  const voiceId = voiceFor(script, line.speaker);
  const file = cachePath(voiceId, line.text);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const audio = await synthesize(voiceId, line.text, lines[index - 1]?.text, lines[index + 1]?.text);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, audio);
  return audio;
}

// Generate every line of every demo script in the background so replays never wait on the network.
export async function prewarmAll(): Promise<void> {
  if (!env("ELEVENLABS_API_KEY")) return;
  let made = 0;
  let failed = 0;
  // The Creator plan allows 5 concurrent TTS requests; stay at 3 to leave room for live use.
  const jobs = ["margaret", "joseph", "dorothy"].flatMap((script) => (getScript(script) ?? []).map((line, i) => ({ script, line, i })));
  const todo = jobs.filter(({ script, line }) => !fs.existsSync(cachePath(voiceFor(script, line.speaker), line.text)));
  const worker = async () => {
    for (let job = todo.shift(); job; job = todo.shift()) {
      try {
        await lineAudio(job.script, job.i);
        made++;
      } catch (err) {
        failed++;
        console.warn(`[tts] ${job.script}#${job.i}: ${(err as Error).message.slice(0, 120)}`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  // Closing lines for both decisions, so the end of a voiced replay never waits on the network.
  for (const script of ["margaret", "joseph", "dorothy"]) {
    for (const d of ["treat_in_place", "transfer"] as const) {
      for (const l of closingLines(getResident(`res_${script}`)!, script, d)) {
        await sayAudio(script, l.speaker, l.text).then(() => made++).catch(() => failed++);
      }
    }
  }
  console.log(`[tts] voiced replay ready (${made} new clips${failed ? `, ${failed} failed` : ""})`);
}

// Any line in a script's cast (used for the physician's closing line and the nurse's acknowledgement).
export async function sayAudio(script: string, speaker: "nurse" | "doctor", text: string): Promise<Buffer> {
  const voiceId = voiceFor(script, speaker);
  const file = cachePath(voiceId, text);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const audio = await synthesize(voiceId, text);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, audio);
  return audio;
}
