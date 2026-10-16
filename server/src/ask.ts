// "Ask the chart": the physician asks a free-text question; Claude writes a small JavaScript function from the
// chart SCHEMA only (never the data); the function runs in a fresh, isolated Daytona sandbox with this one
// resident's chart, and the sandbox is deleted afterwards. Model-written code never runs on our server.
import { Daytona } from "@daytonaio/sdk";
import { env } from "./env.js";
import { callClaude, type ToolDef } from "./llm.js";
import type { Resident } from "./db.js";
import { span } from "./tracing.js";

export type AskResult = {
  question: string;
  ok: boolean;
  text: string;
  table?: { columns: string[]; rows: (string | number)[][] };
  code: string;
  ms: number;
  sandbox: string;
  fallback?: { columns: string[]; rows: (string | number)[][] };
};

const SCHEMA = `type Chart = {
  id: string; name: string; age: number; sex: "F" | "M"; room: string; pcp: string; admitted: string; // YYYY-MM-DD
  diagnoses: string[];
  code_status: { value: string; molst: string; source: string };
  goals_of_care: { summary: string; source: string };
  baseline: { mental_status: string; mobility: string; source: string };
  allergies: string[];
  medications: { name: string; dose: string; class?: string; high_risk?: boolean }[];
  vitals_history: { ts: string; sbp: number; dbp: number; hr: number; rr: number; temp_c: number; spo2: number; o2: string; avpu: string }[]; // ts ISO local, daily, last 14 days
  labs: { ts: string; name: string; value: number; unit: string }[]; // name e.g. "creatinine", "hemoglobin"; ts ISO local
  recent_hospitalization?: { discharged: string; reason: string; source: string };
  notes: { id: string; ts: string; author: string; text: string }[];
};`;

const SYSTEM = `You write one small, pure JavaScript function that answers a physician's question about a nursing home resident's chart.

Rules:
- Define exactly: function answer(chart) { ... } returning { text: string, table?: { columns: string[], rows: (string|number)[][] } }.
- Use only the fields in the schema. Plain JavaScript (ES2020), no imports, no network, no file access, no randomness.
- "text" is one or two plain sentences stating what the data shows (numbers, dates, direction of change). No clinical advice, no diagnosis, no disposition.
- If the chart cannot answer the question, return text saying which data is missing.
- Sort time series oldest to newest. Format dates as YYYY-MM-DD.
- For a trend, state the first value, the highest or lowest value with its date when it differs from both ends, and the latest value.
- Respond only by calling the write_answer_function tool.

Chart schema:
${SCHEMA}`;

const TOOL: ToolDef = {
  name: "write_answer_function",
  description: "Return the JavaScript source of answer(chart).",
  input_schema: {
    type: "object",
    properties: { code: { type: "string", description: "JavaScript source defining function answer(chart)." } },
    required: ["code"],
  },
};

const RUN_TIMEOUT_S = 15;

// Fallback when the sandbox path fails: raw lab rows matching words in the question (or all labs).
function rawRows(r: Resident, question: string) {
  const words = question.toLowerCase();
  const labs = r.labs.filter((l) => words.includes(l.name.toLowerCase()));
  const rows = (labs.length ? labs : r.labs).sort((a, b) => a.ts.localeCompare(b.ts)).map((l) => [l.ts.slice(0, 10), l.name, l.value, l.unit]);
  return { columns: ["Date", "Lab", "Value", "Unit"], rows };
}

export async function askChart(r: Resident, question: string): Promise<AskResult> {
  return span("ask.chart", "TOOL", { "resident.id": r.id, "input.value": question }, () => run(r, question), (res) => ({
    "ask.ok": res.ok, "ask.ms": res.ms, "ask.code": res.code, "output.value": res.text, "ask.sandbox": res.sandbox,
  }));
}

async function run(r: Resident, question: string): Promise<AskResult> {
  const t0 = Date.now();
  let code = "";
  try {
    const gen = await callClaude({ system: SYSTEM, messages: [{ role: "user", content: question }], tools: [TOOL], maxTokens: 4000, effort: "low" });
    code = String((gen.toolCalls.find((t) => t.name === "write_answer_function")?.input as any)?.code ?? "");
    if (!/function\s+answer\s*\(/.test(code)) throw new Error("model did not return answer(chart)");

    if (!env("DAYTONA_API_KEY")) throw new Error("DAYTONA_API_KEY is not set");
    const daytona = new Daytona({ apiKey: env("DAYTONA_API_KEY"), ...(env("DAYTONA_API_URL") ? { apiUrl: env("DAYTONA_API_URL") } : {}) });
    const sandbox = await daytona.create({ language: "typescript" });
    try {
      // Only this one resident's chart goes into the sandbox.
      const program = `const chart = ${JSON.stringify(r)};\n${code}\nconsole.log("__RESULT__" + JSON.stringify(answer(chart)));`;
      const exec = await sandbox.process.codeRun(program, undefined, RUN_TIMEOUT_S);
      const out = exec.result ?? "";
      const line = out.split(/\r?\n/).find((l) => l.startsWith("__RESULT__"));
      if (exec.exitCode !== 0 || !line) throw new Error(`sandbox exit ${exec.exitCode}: ${out.slice(0, 200)}`);
      const parsed = JSON.parse(line.slice("__RESULT__".length));
      return { question, ok: true, text: String(parsed.text ?? ""), table: parsed.table, code, ms: Date.now() - t0, sandbox: sandbox.id };
    } finally {
      await daytona.delete(sandbox).catch(() => {});
    }
  } catch (err) {
    console.warn(`[ask] ${(err as Error).message}`);
    return { question, ok: false, text: "Could not compute. Showing raw data instead.", code, ms: Date.now() - t0, sandbox: "none", fallback: rawRows(r, question) };
  }
}
