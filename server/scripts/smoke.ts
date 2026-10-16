// Smoke test for every sponsor integration. Run: npm run smoke (from repo root or server/).
// Each check prints PASS, FAIL (with a one-line reason), or SKIPPED (key not set). Never crashes.
import "../src/env.js";
import { env } from "../src/env.js";
import { callClaude, llmProvider } from "../src/llm.js";
import { Daytona } from "@daytonaio/sdk";

type Outcome = { status: "PASS" | "FAIL" | "SKIPPED"; detail: string };

class Skip extends Error {}

function requireEnv(...names: string[]) {
  const missing = names.filter((n) => !env(n));
  if (missing.length) throw new Skip(`missing ${missing.join(", ")}`);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms))]);
}

async function run(name: string, fn: () => Promise<string>): Promise<[string, Outcome]> {
  try {
    const detail = await withTimeout(fn(), 90_000);
    return [name, { status: "PASS", detail }];
  } catch (err) {
    if (err instanceof Skip) return [name, { status: "SKIPPED", detail: err.message }];
    const msg = err instanceof Error ? err.message : String(err);
    return [name, { status: "FAIL", detail: msg.split("\n")[0].slice(0, 200) }];
  }
}

async function checkClaude(): Promise<string> {
  if (llmProvider() === "anthropic") requireEnv("ANTHROPIC_API_KEY");
  else requireEnv("BEDROCK_MODEL_ID", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY");
  const res = await callClaude({ messages: [{ role: "user", content: "Reply with exactly: OK" }], maxTokens: 64 });
  if (!res.text.includes("OK")) throw new Error(`unexpected reply: ${res.text.slice(0, 80)}`);
  return `${res.provider} replied "${res.text.trim()}"`;
}

async function checkElevenLabs(): Promise<string> {
  requireEnv("ELEVENLABS_API_KEY");
  // Docs: POST /v1/single-use-token/{token_type} -> { token }
  const r = await fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", {
    method: "POST",
    headers: { "xi-api-key": env("ELEVENLABS_API_KEY") },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const body = (await r.json()) as { token?: string };
  if (!body.token) throw new Error("response had no token");
  return "realtime_scribe single-use token issued";
}

async function checkDaytona(): Promise<string> {
  requireEnv("DAYTONA_API_KEY");
  const daytona = new Daytona({ apiKey: env("DAYTONA_API_KEY"), ...(env("DAYTONA_API_URL") ? { apiUrl: env("DAYTONA_API_URL") } : {}) });
  const sandbox = await daytona.create({ language: "typescript" });
  try {
    const result = await sandbox.process.codeRun("console.log(2+2)");
    const out = (result.result ?? "").trim().split(/\r?\n/)[0].trim();
    if (result.exitCode !== 0 || out !== "4") throw new Error(`exit ${result.exitCode}, output ${JSON.stringify(result.result)}`);
    return `sandbox ran console.log(2+2) -> ${out}`;
  } finally {
    await daytona.delete(sandbox).catch(() => {});
  }
}

async function checkAgentMemory(): Promise<string> {
  requireEnv("SPECTRON_ENDPOINT", "SPECTRON_CONTEXT", "SPECTRON_API_KEY");
  // Docs (hosted quickstart): POST {host}/api/v1/{contextId}/facts and /query, Bearer auth.
  const base = `${env("SPECTRON_ENDPOINT").replace(/\/+$/, "")}/api/v1/${env("SPECTRON_CONTEXT")}`;
  const headers = { Authorization: `Bearer ${env("SPECTRON_API_KEY")}`, "Content-Type": "application/json" };

  const w = await fetch(`${base}/facts`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: "Smoke test: the 2 AM Call server started successfully.", infer: "full" }),
  });
  if (!w.ok) throw new Error(`remember HTTP ${w.status}: ${(await w.text()).slice(0, 150)}`);

  const q = await fetch(`${base}/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: "Did the 2 AM Call server start?" }),
  });
  if (!q.ok) throw new Error(`recall HTTP ${q.status}: ${(await q.text()).slice(0, 150)}`);
  const body = (await q.json()) as { tier?: string };
  return `remember + recall ok (tier: ${body.tier ?? "n/a"})`;
}

const results = await Promise.all([
  run("Claude", checkClaude),
  run("ElevenLabs", checkElevenLabs),
  run("Daytona", checkDaytona),
  run("SurrealDB Agent Memory", checkAgentMemory),
]);

console.log("\nSmoke test results");
console.log("------------------");
for (const [name, o] of results) {
  console.log(`${o.status.padEnd(8)} ${name.padEnd(24)} ${o.detail}`);
}
console.log("");
process.exit(0);
