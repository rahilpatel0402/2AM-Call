# The 2 AM Call: Build Plan for Claude Code

Daytona HackSprint #6, Friday Oct 16, 2026. Solo build.

## How to use this file (instructions for Claude Code)

- Also read `CLAUDE.md` (working rules) and `SCHEDULE.md` (what happens at what time, with beginner click-by-click steps for Rahil). The schedule wins if timing conflicts.
- Read this whole file once. Then work ONE phase at a time, in order. Do not start the next phase until I say "next" or the current phase's "Done when" checks pass.
- After each phase: run it, show me what to click or curl to verify, then `git commit -m "phase N: <name>"`.
- Stack is fixed: React + TypeScript + Vite (client), Node + Express + TypeScript (server). I am not a Python developer. Do not introduce Python.
- Keep it simple. No auth, no Docker, no tests framework, no state library. Plain fetch, Server-Sent Events, useState/useReducer.
- When unsure of any sponsor SDK signature (ElevenLabs, Daytona, Arize, SurrealDB), check the official docs with web fetch before writing code. SDKs change. Do not guess method names.
- All data is synthetic. No real patient information anywhere. Put "SYNTHETIC DATA" in the UI header.
- If any phase runs more than 15 minutes over its time box, stop and tell me, and suggest the cut from the "Cut list" at the bottom.
- Do not use em dashes or en dashes in any UI copy or generated text.

## Timeline (hard stop: finished by 3:00 PM)

| Time | Phase |
|---|---|
| 10:30 to 10:45 | Phase 0: Keys check + scaffold |
| 10:45 to 11:05 | Phase 1: Synthetic data + data store |
| 11:05 to 11:40 | Phase 2: Transcript pipeline (replay first, then live mic) |
| 11:40 to 12:20 | Phase 3: Claude fact extraction + "What wasn't said" panel |
| 12:20 to 12:35 | Lunch at desk (15 min) |
| 12:35 to 1:15 | Phase 4: Safety rules engine + scores + facility feasibility + prior calls |
| 1:15 to 1:45 | Phase 5: Arize tracing + Daytona "Ask the chart" |
| 1:45 to 2:05 | Phase 6: Post-call note + eval script |
| 2:05 to 2:30 | Phase 7: Polish, rehearse, record backup video |
| 2:30 to 3:00 | BUFFER: fixes, slides, submit |

Slides are written at the bottom of this file. I only paste them into a deck during the buffer.

---

## Product summary

**Problem:** At night, a floor nurse in a skilled nursing facility (SNF) calls an on-call physician who is usually not the resident's PCP and has no chart open. Key context goes unsaid (code status, anticoagulation, baseline mental status, goals of care). The physician decides "send to hospital or treat in place" half blind. Result: avoidable transfers, and sometimes delayed transfers for patients who truly need the ED.

**Solution:** An agent that listens to the nurse and physician call, pulls the resident's chart in parallel, and shows the physician in real time:
1. Facts heard on the call (vitals, symptoms, onset)
2. What wasn't said: critical chart context the nurse did not mention
3. Red flags from hard-coded safety rules (never decided by the LLM)
4. Trends vs this resident's baseline, plus NEWS2 computed in code
5. Treat-in-place feasibility: what THIS facility can actually do tonight
6. Prior on-call history for this resident
7. After the call: a draft on-call note and disposition rationale for the physician to edit and sign

**Safety principles (these are product requirements, enforce them in code):**
- The AI never makes the disposition decision. The physician clicks "Transfer" or "Treat in place".
- Red flags come only from deterministic rules in `server/src/safety/rules.ts`. The LLM cannot add, remove, or soften a red flag.
- The UI never displays "do not transfer" or any wording that discourages transfer.
- Every chart fact shown must carry a source reference (document id + field). No source, no display.
- The LLM only does two jobs: (a) extract structured facts from the transcript, (b) decide which checklist items the nurse already mentioned. All numbers come from code.
- Code status of DNR does not suppress red flags. If MOLST says "Do Not Hospitalize", show it prominently but still show red flags.
- The note is a draft. Nothing is filed or signed automatically.

---

## Architecture

```
Browser (React)
  |  mic -> ElevenLabs Scribe v2 Realtime (useScribe, single-use token)
  |  committed transcript segments -> POST /api/calls/:id/segments
  |  live panel updates <- GET /api/calls/:id/stream (SSE)
  v
Express server
  - /api/scribe-token            ElevenLabs single-use token
  - /api/calls                   create call for a resident
  - /api/calls/:id/segments      append segment -> run pipeline
  - /api/calls/:id/stream        SSE push of CallState
  - /api/calls/:id/replay        stream a scripted call (fallback, no mic)
  - /api/calls/:id/ask           "Ask the chart" -> Daytona
  - /api/calls/:id/note          generate draft note
  - /api/calls/:id/disposition   physician decision, saves call record
  Pipeline per segment:
    1. extract.ts   Claude (Bedrock) -> structured facts JSON
    2. merge into CallState
    3. safety/rules.ts   deterministic red flags
    4. scores.ts         NEWS2 + baseline deltas (pure TS)
    5. unsaid.ts         checklist vs mentioned -> pull values from chart
    6. feasibility.ts    facility capabilities vs likely needs
    7. push CallState over SSE
  Data: chart + facility JSON in memory; night call history in SurrealDB Agent Memory (hosted), resident-scoped
  Observability: Arize AX via OpenInference (Bedrock instrumentor) + manual spans
```

Ports: client 5173, server 3001. Vite proxies `/api` to 3001.

---

## Phase 0: Keys check + scaffold (10:30 to 10:45)

**Tasks**
1. Create repo layout:
```
two-am-call/
  client/            Vite React TS
  server/            Express TS (tsx for dev)
  data/              synthetic JSON (Phase 1)
  scripts/           eval runner (Phase 6)
  .env.example
  PLAN.md
```
2. Root `package.json` with `concurrently` script: `npm run dev` starts both.
3. `.env.example` with:
```
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_SESSION_TOKEN=
BEDROCK_MODEL_ID=            # latest Claude Sonnet available in the sandbox; may need a cross-region inference profile id (us.anthropic....)
ANTHROPIC_API_KEY=           # fallback only if Bedrock access fails
LLM_PROVIDER=bedrock         # bedrock | anthropic
ELEVENLABS_API_KEY=
DAYTONA_API_KEY=
ARIZE_SPACE_ID=
ARIZE_API_KEY=
ARIZE_PROJECT_NAME=two-am-call
SPECTRON_ENDPOINT=           # SurrealDB Agent Memory endpoint (old product name Spectron)
SPECTRON_CONTEXT=two-am-call
SPECTRON_API_KEY=
ANCHOR_API_KEY=              # only for stretch module S3
```
4. `server/src/llm.ts`: one function `callClaude({system, messages, tools?, maxTokens})` that supports both providers behind `LLM_PROVIDER`. Bedrock via `@aws-sdk/client-bedrock-runtime` Converse API.
5. `server/scripts/smoke.ts`: one Claude call ("reply OK"), one ElevenLabs token request, one Daytona sandbox create + run `console.log(2+2)` + delete, one SurrealDB Agent Memory remember + recall. Print pass/fail for each.
6. Create a PUBLIC GitHub repo now (required for Devpost), add `.gitignore` with `.env`, push the scaffold. Push after every phase from here on. Never commit keys.
7. AWS: use the hackathon lab account. If Bedrock model access is not enabled in the lab account within 5 minutes, use `LLM_PROVIDER=anthropic`.

**Done when:** `npm run dev` shows a blank page with header "The 2 AM Call  |  SYNTHETIC DATA", and `npx tsx server/scripts/smoke.ts` prints PASS for Claude, ElevenLabs, Daytona. If Bedrock fails, switch `LLM_PROVIDER=anthropic` and move on. Do not debug IAM for more than 5 minutes.

---

## Phase 1: Synthetic data + data store (10:45 to 11:05)

Create these files in `/data`. Every record has an `id`. Every chart field the UI may show must be addressable as `docId.field`.

### `data/facility.json`
```json
{
  "id": "fac_bayview",
  "name": "Bayview Rehab and Nursing (synthetic)",
  "overnight": {
    "rn_on_site": true,
    "iv_fluids": true,
    "iv_antibiotics": true,
    "stat_labs": { "available": true, "turnaround_hours": 4 },
    "mobile_xray": { "available": true, "earliest": "06:00" },
    "ct_imaging": false,
    "oxygen_max_lpm": 5,
    "telemetry": false,
    "pharmacy_stat_delivery_hours": 3
  }
}
```

### Residents (3 files): `data/residents/*.json`
Schema:
```ts
type Resident = {
  id: string; name: string; age: number; sex: "F" | "M";
  room: string; pcp: string; admitted: string;
  diagnoses: string[];
  code_status: { value: string; molst: string; source: string };
  goals_of_care: { summary: string; source: string };
  baseline: { mental_status: string; mobility: string; source: string };
  allergies: string[];
  medications: { name: string; dose: string; class?: string; high_risk?: boolean }[];
  vitals_history: { ts: string; sbp: number; dbp: number; hr: number; rr: number; temp_c: number; spo2: number; o2: string; avpu: "A"|"C"|"V"|"P"|"U" }[];  // 14 days
  labs: { ts: string; name: string; value: number; unit: string }[];   // include creatinine and hemoglobin trends
  recent_hospitalization?: { discharged: string; reason: string; source: string };
  notes: { id: string; ts: string; author: string; text: string }[];   // 3 to 5 short nursing/provider notes
};
```

**Resident A: Margaret Ellis, 84 F (true emergency)**
- Dx: atrial fibrillation, HTN, osteoarthritis, mild CKD.
- Meds include **apixaban 5 mg BID (anticoagulant, high_risk)**. 
- Baseline: alert and oriented x3, walks with walker.
- Code status: Full code, MOLST full treatment.
- Vitals history stable, SBP 130s.
- Scenario: unwitnessed fall at 1:40 AM, small bump on forehead, now "a little confused".

**Resident B: Joseph Ramirez, 79 M (treat in place candidate)**
- Dx: moderate Alzheimer dementia, BPH, recurrent UTI.
- Baseline: oriented to self only, sundowning, needs 1 assist.
- Code status: DNR/DNI, **MOLST: Do Not Hospitalize unless comfort cannot be achieved**. Goals: family (daughter) prefers treatment at facility.
- Vitals history: SBP 120s, HR 70s.
- Scenario: temp 38.0 C, slightly more confused than usual, drinking less. BP 128/74, HR 92, RR 18, SpO2 95% RA.
- Prior calls: 2 on-call calls in the last 7 days (agitation, poor intake).

**Resident C: Dorothy Kim, 88 F (eval trap: subtle shock)**
- Dx: CHF, diabetes on insulin, recent hospitalization for pneumonia, discharged 6 days ago.
- Meds include furosemide, lisinopril, insulin glargine.
- Baseline SBP 135, HR 70s, alert.
- Scenario: nurse says "just more tired, BP a little low". Actual: BP 88/52, HR 112, RR 24, SpO2 91% RA, temp 37.9.
- Purpose: proves the rules fire even when the nurse downplays.

### `data/prior_calls.json`
Two calls for Joseph in last 7 days, one call for Margaret 3 weeks ago. Fields: `id, residentId, ts, physician, reason, disposition, summary`.

### Call scripts: `data/scripts/*.json`
Array of `{ speaker: "nurse" | "doctor", text: string, delayMs: number }`. 10 to 16 lines each. Write realistic SNF night call language. Key rule: in each script the nurse OMITS the important context:
- Margaret script: nurse never mentions apixaban or that baseline is A&Ox3.
- Joseph script: nurse never mentions MOLST Do Not Hospitalize or the 2 prior calls.
- Dorothy script: nurse says BP is "a little low" and only gives numbers when the doctor asks.

### Chart store: `server/src/db.ts`
- Chart and facility data: load the JSON files into memory at boot. Helpers: `getResident(id)`, `getFacilityForResident(id)`.

### On-call memory: `server/src/memory.ts` (SurrealDB Agent Memory, the SurrealDB prize)
This is the resident's memory across night calls: what happened, what was decided, what the family said. It is exactly what an on-call doctor who has never met the resident lacks.
- Use the hosted SurrealDB Agent Memory service with the participant credit. JS package `@surrealdb/agent-memory` (`remember`, `recall`). Note: env vars and some packages still use the old name `SPECTRON_*`. Read the Agent Memory AGENTS.md / hosted quickstart before coding. Do not guess.
- Scope every memory to the resident (resident id as scope or label) so one resident's memories never appear in another's call.
- Seed at boot: write each record from `data/prior_calls.json` as a memory, e.g. "On-call 2026-10-12 02:10: agitation and poor intake. Treated in place. Daughter Maria reiterated no hospital transfer unless comfort cannot be achieved."
- At call start: `recall("recent on-call events, decisions, and family wishes")` scoped to the resident. Show results in the Prior Calls card WITH their timestamp and source. Agent Memory keeps provenance and time on records, so display it.
- After the physician signs a note (Phase 6): `remember` the call summary + disposition. Next replay of the same resident must show it. This is the demo moment for SurrealDB.
- Helpers: `recallForResident(id)`, `rememberCall(call)`.
- **Fallback if Agent Memory setup takes over 15 minutes:** same helper signatures backed by an in-memory array filtered by resident id and date. Leave a TODO.

**Done when:** `GET /api/residents` returns 3 residents; `GET /api/residents/res_joseph/memory` returns the 2 prior calls with timestamps.

---

## Phase 2: Transcript pipeline (11:05 to 11:40)

Build REPLAY first. It is the demo fallback and the eval harness. Then LIVE mic.

### 2a. Call state + SSE (server)
```ts
type Segment = { id: string; ts: number; speaker?: "nurse"|"doctor"|"unknown"; text: string };
type CallState = {
  callId: string; residentId: string; startedAt: number;
  segments: Segment[];
  facts: ExtractedFacts | null;       // Phase 3
  unsaid: UnsaidItem[];               // Phase 3
  redFlags: RedFlag[];                // Phase 4
  scores: Scores | null;              // Phase 4
  feasibility: FeasibilityItem[];     // Phase 4
  priorCalls: PriorCall[];            // Phase 4
  status: "live" | "ended";
};
```
- In-memory `Map<callId, CallState>`.
- `GET /api/calls/:id/stream` SSE, push full CallState on every change.
- `POST /api/calls/:id/segments` appends, triggers pipeline (debounced 700 ms so bursts of segments run once).

### 2b. Replay mode
- `POST /api/calls/:id/replay { script: "margaret" }` streams script lines into segments using `delayMs`, with speaker labels.

### 2c. Live mode (ElevenLabs Scribe v2 Realtime)
- Server: `GET /api/scribe-token` using `@elevenlabs/elevenlabs-js` single-use token for `realtime_scribe`.
- Client: `@elevenlabs/react` `useScribe`, VAD commit strategy. On each committed transcript, POST it as a segment with `speaker: "unknown"`. Show partial transcript in grey while speaking.
- Verify current parameters in the ElevenLabs realtime STT docs before coding.

### 2d. Client UI skeleton
Layout (desktop, laptop screen):
```
+----------------------------------------------------------------------+
| The 2 AM Call | SYNTHETIC DATA | Resident: [select]  [Replay][Live] |
+---------------------------+------------------------------------------+
| LIVE TRANSCRIPT           |  RED FLAGS (top, red, always visible)    |
|  nurse: ...               +------------------------------------------+
|  doctor: ...              |  WHAT WASN'T SAID      | HEARD ON CALL   |
|  (partial in grey)        |  - Anticoagulant: ...  | BP 88/52 ...    |
|                           |    [source: med list]  |                 |
|                           +------------------------------------------+
|                           |  VS BASELINE + NEWS2   | FACILITY TONIGHT|
|                           +------------------------------------------+
|                           |  PRIOR CALLS (7 days)  | ASK THE CHART   |
+---------------------------+------------------------------------------+
| [End call]  -> Draft note panel -> [Transfer] [Treat in place] [Sign]|
+----------------------------------------------------------------------+
```
Use plain CSS grid. Dark navy header, white cards, red for red flags, amber for "wasn't said", green/grey for feasibility. Large readable font: the judges view from a distance.

**Done when:** selecting Margaret and clicking Replay streams the script into the transcript panel; clicking Live and speaking shows text appear within about a second.

---

## Phase 3: Claude extraction + "What wasn't said" (11:40 to 12:20)

### 3a. `server/src/extract.ts`
Call Claude with a tool/JSON schema. Input: full transcript so far (with speakers if known). Output:
```ts
type ExtractedFacts = {
  chief_concern: string | null;
  onset: string | null;
  vitals_reported: { sbp?: number; dbp?: number; hr?: number; rr?: number; temp_c?: number; spo2?: number; o2?: string; quote: string }[];
  symptoms: { name: string; present: boolean; quote: string }[];   // e.g. head_strike, new_confusion, chest_pain, focal_weakness, dyspnea, poor_intake, fall
  events: { type: "fall"|"other"; witnessed?: boolean; head_strike?: boolean; quote: string }[];
  mentioned_checklist: { item: ChecklistItem; mentioned: boolean; quote?: string }[];
};
type ChecklistItem = "code_status" | "anticoagulation" | "baseline_mental_status" | "allergies" | "recent_hospitalization" | "goals_of_care" | "recent_labs" | "prior_calls";
```
System prompt rules:
- Extract only what was said. Every extracted item must include a verbatim quote from the transcript.
- If temperature is given in Fahrenheit, return the number as said in `quote` and convert in code, not in the model. (Add `temp_f` field and convert in TS.)
- Do not give clinical advice. Do not suggest disposition.
- Return JSON only via the tool.

Post-processing in code:
- Drop any extracted item whose `quote` is not a substring of the transcript (normalize case and whitespace). This is the anti-hallucination check. Log dropped items to Arize later.

### 3b. `server/src/unsaid.ts` (deterministic)
For each checklist item NOT mentioned, pull the value from the chart and attach source:
- anticoagulation: any med with class anticoagulant or antiplatelet
- code_status: `code_status.value` + `molst`
- baseline_mental_status: `baseline.mental_status`
- goals_of_care: `goals_of_care.summary`
- recent_hospitalization: if within 30 days, "Discharged N days ago for X"
- recent_labs: last creatinine and hemoglobin with date
- allergies
- prior_calls: count in last 7 days (from db)
Priority order for display: anticoagulation, code status/MOLST, baseline mental status, recent hospitalization, goals of care, prior calls, labs, allergies. Show at most 5, the rest behind "more".

**Done when:** Margaret replay shows "What wasn't said: Anticoagulant: apixaban 5 mg BID [source: medication list]" and "Baseline: A&Ox3" within a few seconds of the fall being described. Joseph replay shows the MOLST Do Not Hospitalize item.

---

## Lunch (12:20 to 12:35)

Leave replay of Joseph running and sanity check the panel while eating.

---

## Phase 4: Safety rules + scores + feasibility + prior calls (12:35 to 1:15)

### 4a. `server/src/scores.ts` (pure TS)
- Current vitals = latest reported on call, falling back to latest chart vitals for missing fields (mark which ones came from the chart).
- NEWS2 total and per-parameter points (standard NEWS2 table, scale 1 for SpO2). Include a unit test style self-check function with 2 known examples.
- Baseline = median of the last 14 days of chart vitals. Show deltas: "SBP 88 vs baseline 134 (down 46)".

### 4b. `server/src/safety/rules.ts` (deterministic, the heart of the safety story)
Each rule: `{ id, title, why, evidence: string[] }`. Fire when:
| id | Condition |
|---|---|
| hypotension | SBP < 90, or SBP drop >= 40 from baseline |
| hypoxia | SpO2 < 90 on current O2, or new O2 requirement |
| tachycardia | HR > 130 (or HR > 110 with SBP < 100) |
| bradycardia | HR < 40 |
| tachypnea | RR >= 25 |
| sepsis_pattern | temp >= 38.0 AND (SBP < 100 OR RR >= 22 OR new confusion) |
| fall_anticoag | fall AND (head strike OR unwitnessed) AND resident on anticoagulant |
| new_confusion_vs_baseline | new or worse confusion when baseline is oriented x3 |
| stroke_signs | focal weakness, facial droop, or new speech change |
| chest_pain | chest pain reported |
| news2_high | NEWS2 >= 7, or any single parameter scoring 3 |

Rules about rules:
- Red flag panel copy: "Consider urgent evaluation / transfer. Physician decision." Never "send" as a command, never "do not send".
- If MOLST is Do Not Hospitalize or DNR, add a neutral note under the flags: "Goals of care on file: <text>. Red flags still shown." Do not hide or downgrade flags.
- The LLM output has no field that can affect this file. Add a comment at the top saying so.

### 4c. `server/src/feasibility.ts`
Map likely needs from facts to facility capabilities, show what the facility can and cannot do tonight:
- fever/infection: stat labs (4 h turnaround), IV antibiotics, IV fluids
- fall with head strike: CT imaging (not available tonight)
- hypoxia: oxygen up to 5 L, no high-flow
- chest pain: telemetry (not available), stat ECG if listed
Display as checklist: "Can tonight: stat CBC/BMP (results by ~6 AM), IV fluids, IV ceftriaxone. Cannot tonight: CT head." Neutral wording, no recommendation.

### 4d. Prior calls card
From `recallForResident()` (SurrealDB Agent Memory): calls in last 7 days with date, reason, disposition, and any family wishes recalled. Highlight if 2 or more: "3rd call this week for this resident." Label the card "Remembered from prior night calls".

**Done when:**
- Margaret: red flags `fall_anticoag` + `new_confusion_vs_baseline`; feasibility shows "CT head: not available tonight".
- Joseph: zero red flags; feasibility green for labs/IV/antibiotics; MOLST note visible; "3rd call this week".
- Dorothy: `hypotension`, `tachycardia`, `sepsis_pattern`/`news2_high` fire even though the nurse said "a little low".

---

## Phase 5: Arize tracing + Daytona "Ask the chart" (1:15 to 1:45)

### 5a. Arize AX (15 min max)
- Use `@arizeai/openinference-instrumentation-bedrock` for Bedrock calls. Known issue: load the instrumentor with `require` (CommonJS) because the ESM build currently fails; check the Arize Bedrock tracing doc. Instrumentation must be imported before the Bedrock client is created.
- Set a session id = callId on every span so one call is one session in Arize.
- Add manual OpenTelemetry spans: `pipeline.run`, `extract.validate_quotes` (attributes: kept, dropped), `safety.rules` (attributes: fired rule ids), `unsaid.compute` (items surfaced).
- If instrumentation fights you for more than 15 minutes, keep only manual spans with the OTLP exporter and move on.

### 5b. Daytona "Ask the chart" (15 min max)
Physician types a free question, e.g. "trend her creatinine over 3 months" or "how many falls in 90 days".
1. Server sends Claude the question + the resident JSON SCHEMA (not the full chart) and asks for a short JavaScript function `answer(chart)` that returns `{ text, table? }`.
2. Create a Daytona sandbox (TypeScript/JavaScript), write `chart.json` and the generated code, run it, capture stdout, delete the sandbox.
3. Show the result and a collapsible "code that ran" so the physician can see the basis.
Why Daytona: model-generated code never runs on our server or near other patients' data. One sandbox per question, destroyed after.
Timeout 15 s. On error show "Could not compute. Showing raw data instead." and list the relevant lab rows.

**Done when:** a call appears as a session in Arize with the custom spans; "trend creatinine" for Dorothy returns values computed in Daytona.

---

## Phase 6: Post-call note + eval script (1:45 to 2:05)

### 6a. Draft note
`POST /api/calls/:id/note`: Claude writes an on-call note from CallState ONLY (facts, unsaid items, flags, scores, feasibility). Sections: Situation, Relevant history surfaced, Assessment data, Red flags, Facility capability tonight, Physician decision: [blank], Plan: [blank]. Physician fills decision by clicking Transfer or Treat in place, and the rationale line is drafted from what they chose. Editable textarea. "Sign" calls `rememberCall()` so it shows up in the Prior Calls card on the next call for this resident. Footer: "Draft generated by AI. Reviewed and signed by: <physician>".

### 6b. `scripts/eval.ts`
Runs all 3 scripts through the pipeline without the UI and checks expectations:
```ts
const expectations = {
  margaret: { mustFlag: ["fall_anticoag","new_confusion_vs_baseline"], mustSurface: ["anticoagulation","baseline_mental_status"] },
  joseph:   { mustFlag: [], mustNotFlag: ["hypotension","sepsis_pattern"], mustSurface: ["goals_of_care","prior_calls"] },
  dorothy:  { mustFlag: ["hypotension","tachycardia"], mustSurface: ["recent_hospitalization"] },
};
```
Also count hallucinated quotes dropped. Print a table: case, flags expected vs fired, surfaced items, dropped quotes, PASS/FAIL. Run it 3 times (LLM variability) and report pass rate. Send results as spans to Arize with attribute `eval.case`. Screenshot this table for the slides.

**Done when:** `npx tsx scripts/eval.ts` prints the table with all PASS.

---

## Phase 7: Polish + rehearse + backup video (2:05 to 2:30)

- Big "SYNTHETIC DATA" badge. Resident photo placeholder initials only.
- Red flag card animates in. Unsaid items slide in. Keep animations short.
- Write `README.md` (judges in Round 1 read the repo): one-line summary, screenshot, problem, architecture diagram (the ASCII one above), sponsor tools and exactly how each is used, safeguards, how to run, "All data synthetic".
- Record the Devpost demo video, UNDER 2 MINUTES (aim for 1:45): Margaret replay, Joseph replay with treat in place + sign, Joseph again showing the remembered call, eval table, one Arize trace. Voiceover. This video is also the stage backup.
- Push to GitHub.

## BUFFER (2:30 to 3:00)
Fix whatever broke. Upload video (YouTube unlisted or Loom). Paste the Devpost text below, add repo URL, email and socials. Submit by 3:00 (deadline is 3:30, do not use it). Paste slides into a deck. Rehearse the pitch once with a timer.

---

## Judging map (each criterion 25%, sponsor usage is bonus)

Round 1 is judged ONLY from Devpost. Top 8 pitch. Best Use awards can go to any team, finalist or not, so the README and Devpost must explain sponsor usage clearly.

| Criterion | What earns it here |
|---|---|
| Impact | Every SNF has night calls; avoidable transfers are costly and harmful; missed transfers kill. Cite the after-hours call research |
| Technical execution | Working live pipeline, deterministic safety layer, quote validation, eval suite with pass rate |
| Creativity | Ambient AI for the clinician-to-clinician call (everyone else does patient visits); facility capability; memory across night calls |
| Presentation | Two contrasting live cases; the "nurse downplays shock" eval |
| Sponsors | ElevenLabs (core input), Daytona (isolated model-written code), Arize (traces + evals), SurrealDB Agent Memory (cross-call memory with provenance), AWS Bedrock (Claude) |

Anchor Browser is not used. Only add it if every phase is done well before 1:55 (stretch: Anchor logs into a mock web EHR portal to pull the chart, since on-call doctors often lack remote EHR access). Otherwise skip. A forced integration scores worse than none.

---

## Devpost text (paste in buffer, edit numbers from eval)

**Team name:** The 2 AM Call

**Summary:** The 2 AM Call is an AI agent that listens to the night phone call between a nursing home nurse and an on-call physician, reads the resident's chart in parallel, and shows the physician in real time what wasn't said, rule-based red flags, trends against the resident's own baseline, what the facility can actually do tonight, and what happened on prior night calls. The physician makes the transfer decision faster and with the full picture; the AI never makes it.

**Problem and impact:** In skilled nursing facilities, the decision to send a resident to the hospital is usually made on a phone call at night with a doctor who has never met the patient and has no chart open. Research on after-hours nurse to physician calls shows key information often goes uncommunicated, and structured forms alone do not fix it. The result is avoidable hospital transfers (costly, and harmful for frail residents) and delayed transfers for residents who truly need the ED. Built by a physician who has worked these calls across 40+ facilities.

**Architecture:** React + TypeScript client, Express + TypeScript server. ElevenLabs Scribe v2 Realtime streams the call transcript. Claude on AWS Bedrock extracts facts, each with a verbatim quote that is validated against the transcript in code. A deterministic safety layer computes red flags and NEWS2; the LLM cannot add, remove, or soften them. A chart engine surfaces unmentioned critical context with sources. A facility capability model shows what can be done overnight. SurrealDB Agent Memory holds each resident's night call history. Draft note generated after the call for physician signature.

**Sponsor tools:**
- ElevenLabs Scribe v2 Realtime: live call transcription, the agent's primary input
- AWS Bedrock: Claude for fact extraction, chart questions, and note drafting
- Daytona: physician's free-form chart questions are answered by model-written code that runs only in a disposable, isolated sandbox, with the code shown to the physician
- Arize AX: every call is a traced session (extraction, dropped quotes, fired rules); eval suite results logged, including a case where the nurse downplays shock
- SurrealDB Agent Memory: resident-scoped memory of prior night calls, decisions, and family wishes, recalled at the start of every call and written after each signed note

**Safeguards:** physician decides disposition; deterministic red flags; source on every fact; hallucinated quotes dropped; goals of care never hide red flags; synthetic data only.

---

## Q&A prep (2 minutes after pitch)

- "Is this FDA regulated?" It surfaces chart information and rule-based flags with visible sources; the physician decides. Production would follow FDA CDS guidance and clinical validation before use.
- "What about HIPAA?" Demo is synthetic. Production would run on HIPAA-eligible infrastructure (Bedrock under a BAA), no audio retention by default.
- "What if transcription is wrong?" Every extracted fact shows its quote; vitals fall back to the chart and are labeled; red flags also run on charted vitals.
- "How do you measure success?" Transfer rate and 72-hour return-to-hospital rate for treat-in-place residents, time to decision, physician-rated missed information.
- "Who pays?" SNF operators and physician groups covering nights (reduced transfers, readmission penalties), and value-based care entities.

---

## Cut list (cut in this order if behind)

1. Daytona "Ask the chart" (keep a stub button) - but try to keep it, it is the Daytona prize
2. Arize automatic instrumentation (keep manual spans only)
3. SurrealDB Agent Memory (use in-memory store with the same helpers)
4. Live mic (demo with replay only, say "replay of a recorded call")
5. Note editing (show read-only draft)

Never cut: replay mode, rules engine, "What wasn't said", eval table.

---

## Stretch modules (use more sponsor resources, same project)

Only start one at the 1:55 gate in `SCHEDULE.md`, and only if Phase 6 is done by then. In practice that means S1 only. Hard stop 2:10, then Phase 7.

### S1. ElevenLabs voice brief (15 min) - adds Text to Speech to Speech to Text
**Why it is real:** at 2 AM the on-call doctor is often in bed on a phone, not at a screen. A 15 second spoken brief reaches them where they are.
- Button "Play brief to physician" on the call screen.
- Brief text is built by CODE from the current CallState (not free LLM text): "Before you decide. Margaret Ellis is on apixaban. Baseline alert and oriented times three. Red flags: fall on anticoagulant with head strike. This facility has no CT tonight."
- Red flags are always read first. If none: "No rule based red flags." Never say "safe to keep".
- ElevenLabs Text to Speech via `@elevenlabs/elevenlabs-js` (server endpoint returns audio, client plays it). Pick a calm voice. Check docs for the current method name.
- Add to Devpost and README sponsor list: "ElevenLabs Text to Speech delivers a code-generated spoken brief to physicians who are on the phone, not at a screen."

### S2. Arize note faithfulness eval (15 min) - deeper Arize usage
- After the draft note is generated, run an LLM-as-judge check: does every statement in the note appear in CallState (facts, unsaid items, flags)? Output `faithful: true|false` plus any unsupported sentences.
- Log as an evaluation on the note span in Arize (check Arize AX docs for logging evals from TypeScript; if that API is unclear, set span attributes `eval.faithful` and `eval.unsupported_count`).
- Add a row to `scripts/eval.ts`: note faithfulness pass rate across the 3 cases.
- In the UI, show a small badge on the note: "Faithfulness check: passed" or the unsupported lines highlighted.

### S3. Anchor Browser chart pull (30 to 40 min, only if 30+ minutes ahead)
**Why it is real:** on-call doctors often lack remote EHR login; many SNF EHRs are web portals with no API for an outside on-call group.
- Build `mock-ehr/index.html`: a plain static page that looks like a generic web EHR (no real vendor names or branding), with a login form (demo credentials) and Margaret's med list and MOLST.
- Anchor's cloud browser cannot reach localhost. Publish the mock page somewhere public: simplest is GitHub Pages from the `mock-ehr` folder (repo Settings > Pages > Deploy from branch > folder). Walk Rahil through the clicks.
- Server endpoint `/api/residents/:id/pull-chart`: start an Anchor session, use its natural language web task tool (`/v1/tools/perform-web-task`) with the goal "log in with demo credentials and extract the medication list and MOLST as JSON". Validate returned JSON against the schema, then merge into the chart with source "Anchor pull from web EHR".
- UI: "Pull chart from EHR portal" button with a status line. Keep the JSON chart as fallback.
- Add to Devpost sponsor list only if it works end to end.

**Do not** add any stretch module half finished. If it is not working at 2:10, revert it (`git checkout .` for that module) and go to Phase 7.

---

## Demo script (3 minutes)

1. (20 s) Slide 1 problem.
2. (60 s) Live: Margaret. Partner reads the nurse lines (or replay). Point at "Wasn't said: apixaban" appearing, then red flags, then "CT not available tonight". "The AI didn't decide. It made sure the doctor knew."
3. (45 s) Joseph replay. Zero red flags, MOLST Do Not Hospitalize surfaced, facility can do labs and IV antibiotics tonight, 3rd call this week. Click Treat in place, show draft note.
4. (25 s) Eval table: Dorothy case, nurse downplayed, rules still fired. Arize trace.
5. (30 s) Safeguards slide + close.

---

## Slides (paste into deck during buffer)

**Slide 1: The most important decision in a nursing home happens on a phone call at 2 AM**
- Floor nurse calls an on-call doctor who has never met the resident and has no chart open
- Key context goes unsaid: blood thinners, code status, baseline, goals of care
- Result: avoidable hospital transfers, and missed transfers that matter
- Research: in after-hours nurse to physician calls, key information often goes uncommunicated, and an SBAR form alone did not fix it

**Slide 2: The 2 AM Call**
- Listens to the call, reads the chart in parallel
- Shows what wasn't said, red flags, trends vs baseline, what the facility can do tonight, prior calls
- Drafts the on-call note after the call
- Built by a physician who has taken these calls across 40+ SNFs

**Slide 3: Live demo**

**Slide 4: Safeguards**
- AI never decides disposition. Physician clicks Transfer or Treat in place
- Red flags are deterministic rules. The LLM cannot add, remove, or soften them
- Every fact cites its source. Quotes not found in the transcript are dropped
- Goals of care shown, never used to hide red flags
- Model-written analysis code runs only in isolated Daytona sandboxes
- Every step traced in Arize; eval suite includes a nurse-downplays-shock case
- Synthetic data only

**Slide 5: Built with**
Claude on AWS Bedrock, ElevenLabs Scribe v2 Realtime, Daytona sandboxes, SurrealDB, Arize AX

---

## First message to give Claude Code

"Read CLAUDE.md, SCHEDULE.md, and PLAN.md. Then do Phase 0 only. Walk me through anything I need to click, and show me how to verify it when done."
