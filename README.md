# The 2 AM Call

**An AI co-pilot for the night phone call between a nursing home nurse and an on-call physician. It listens to the call, reads the facility chart in parallel, and shows the doctor what wasn't said, rule-based red flags, trends against the resident's own baseline, and what the facility can actually do tonight. The physician makes every decision.**

> All data in this repository is synthetic. No real patient information is used anywhere.

![The 2 AM Call dashboard](docs/screenshot.png)

## The problem

At 2 AM a skilled nursing facility nurse calls an on-call physician who has never met the resident and has no chart open. Critical context goes unsaid: blood thinners, code status, baseline mental status, goals of care, a hospital discharge last week. The physician decides "send to the hospital or treat here" half blind. The result is avoidable transfers, which are costly and harmful for frail residents, and delayed transfers for residents who truly need the emergency department.

On-call physician groups also rarely have API access to each facility's EHR. Getting the chart means a slow web portal login at 2 AM.

Built by a physician who has taken these calls across 40+ facilities.

## What it does

| On the call | What the physician sees |
|---|---|
| Nurse and doctor talk | Live transcript (ElevenLabs Scribe v2 Realtime), or a voiced replay of a recorded call |
| Nurse names the resident | Anchor Browser signs into the facility's web EHR portal and reads the chart in about 10 seconds, shown live in a picture-in-picture window |
| Facts are stated | **Heard on call:** vitals, symptoms, events. Every item is linked to its verbatim quote |
| Context is missing | **Not yet mentioned:** anticoagulant, code status / MOLST, baseline, recent hospitalization, goals of care, prior night calls, glucose check for residents on insulin. Each with its source. Items move to "Covered on call" when the nurse says them |
| Vitals are abnormal | **Red flags** from deterministic rules, **NEWS2**, and tonight's vitals against the resident's own 14 day baseline |
| Decision time | **Facility capability tonight:** what this building can and cannot do overnight (no CT, IV antibiotics yes, labs by 6 AM) |
| Repeat caller | **Remembered from prior night calls** (SurrealDB Agent Memory): "3rd call this week for this resident" |
| A specific question | **Ask the chart:** "trend her creatinine over 3 months", answered by model-written code in a disposable Daytona sandbox |
| Physician decides | Transfer or Treat in place. The physician's closing line is spoken to the nurse, a draft note is generated from the call record, the physician edits and signs, and Anchor posts it to the facility EHR |

## Three demo residents

| Resident | Scenario | What the app catches |
|---|---|---|
| Margaret Ellis, 84 | Unwitnessed fall, bump on forehead, "a little confused" | Nurse never mentions **apixaban** or that her baseline is **alert and oriented x3**. Red flags: fall on anticoagulant (NICE NG232: consider CT head within 8 hours), acute mental status change. Facility: **no CT tonight** |
| Joseph Ramirez, 79 | Fever 38.0 C, more confused than usual, dementia | Possible sepsis and possible delirium superimposed on dementia, shown **alongside** his MOLST **Do Not Hospitalize** order and a facility that **can** give IV antibiotics and labs tonight. 3rd call this week |
| Dorothy Kim, 88 | "Just more tired, BP a little low" | The nurse downplays shock: 88/52, HR 112, RR 24, SpO2 91%, 37.9 C. Red flags fire anyway: hypotension, tachycardia, **possible sepsis by the long-term care fever definition** (37.9 C is a fever in a nursing home resident), qSOFA 2, NEWS2 10. Not yet mentioned: discharged 6 days ago, and no glucose check while on insulin |

## Architecture

```
Browser (React + TypeScript)
  |  mic -> ElevenLabs Scribe v2 Realtime (single-use token)   or   voiced replay (ElevenLabs TTS)
  |  transcript segments -> POST /api/calls/:id/segments
  |  live dashboard      <- GET  /api/calls/:id/stream (Server-Sent Events)
  v
Express + TypeScript server
  Pipeline per burst of speech (debounced):
    1. extract.ts      Claude (AWS Bedrock) -> facts as JSON via tool call, each with a verbatim quote
                       code drops any item whose quote is not in the transcript, any vital whose number
                       is not in its quote, and denied events ("no fall"); temperature units decided in code
    2. unsaid.ts       checklist vs mentioned -> chart values with sources (deterministic)
    3. scores.ts       current vitals, 14 day median baseline, NEWS2 (pure TypeScript, self-checked)
    4. safety/rules.ts deterministic red flags (no LLM input except validated facts)
    5. feasibility.ts  facility capability tonight vs likely needs
  Chart:    read from the facility web EHR portal by Anchor Browser (falls back to a local copy)
  Memory:   SurrealDB Agent Memory, resident-scoped prior night calls; signed calls written back
  Ask:      Claude writes answer(chart) from the schema only -> runs in a fresh Daytona sandbox
  Note:     Claude drafts from the call record only -> physician edits and signs -> Anchor posts it
  Traces:   Arize AX (OpenTelemetry + OpenInference), one session per call
```

## Sponsor tools and exactly how each is used

| Tool | How The 2 AM Call uses it |
|---|---|
| **AWS Bedrock (Claude Sonnet 5.5)** | Three jobs, all traced: (1) extract facts from the call transcript with verbatim quotes via a tool schema, (2) write a small JavaScript function to answer a free-text chart question, (3) draft the on-call note from the call record only. Claude never decides disposition and never produces a red flag |
| **ElevenLabs** | **Speech to Text:** Scribe v2 Realtime transcribes the live call in the browser using a server-minted single-use token. **Text to Speech:** voiced replay of recorded calls (nurse and physician voices), including the physician's closing line telling the nurse the plan. Clips are generated once and cached |
| **Anchor Browser** | Nursing home EHRs are usually reachable by an outside on-call group only through a web portal. When the nurse names the resident, Anchor opens a cloud browser, signs into the facility portal, opens the resident, and reads code status, goals of care, baseline, allergies, medications, 14 days of vitals, and labs. The dashboard uses that chart. On Sign, Anchor posts the note into the portal's progress notes, verified against the portal's own records. Both runs are visible live in an embedded picture-in-picture view |
| **Daytona** | "Ask the chart": model-written code runs only inside a fresh, isolated sandbox with one resident's chart, and the sandbox is deleted afterwards. Model-generated code never runs on our server or near other residents' data. The physician can expand "Code that ran" |
| **SurrealDB Agent Memory** | Resident-scoped memory of prior night calls, decisions, and family wishes. Recalled at the start of every call and shown with timestamps and source. Signing a note writes the call back, so the next on-call physician sees it |
| **Arize AX** | Every call is one session. Each pipeline run is a trace with the Bedrock call, quote validation (kept vs dropped), unsaid items, fired rule ids, Ask-the-chart code, and Anchor runs. The eval suite logs each case as an evaluator span |

## Safeguards (enforced in code)

- **The AI never makes the disposition decision.** Transfer and Treat in place are equal-weight buttons clicked by the physician. No screen ever says "do not transfer".
- **Red flags come only from deterministic rules** in [`server/src/safety/rules.ts`](server/src/safety/rules.ts). LLM output cannot add, remove, or soften a flag. Rules are tuned for older adults in skilled nursing with guideline citations inline: IDSA long-term care fever definition, NICE NG232 head injury, qSOFA, RCP NEWS2, delirium superimposed on dementia, beta-blocker and donepezil context.
- **Every fact has a source.** Extracted facts carry a verbatim quote; chart facts carry their document or "facility EHR portal (Anchor)".
- **Hallucinated quotes are dropped** before anything is shown. Unverifiable "mentioned" claims count as not mentioned, so the chart fact still surfaces.
- **Goals of care are shown but never hide red flags.** A Do Not Hospitalize order appears as a neutral note under the flags.
- **The note is a draft** written only from the call record. Nothing is filed until the physician signs.
- **Model-written code runs only in a disposable Daytona sandbox.**
- **Synthetic data only.**

## Evaluation

`npm run eval` runs 9 scripted calls through the real pipeline 3 times each (LLM variability) and checks required and forbidden flags, surfaced and covered items, and unit conversion. Results are also logged to Arize.

| Case | What it proves |
|---|---|
| margaret | Fall on anticoagulant, delirium vs baseline; apixaban and baseline surfaced |
| joseph | Possible sepsis in dementia; MOLST and prior calls surfaced |
| dorothy | Nurse downplays shock; hypotension, tachycardia, sepsis (LTC fever), qSOFA fire |
| clean_call | Routine call, normal vitals: no false alarms |
| nurse_says_it_all | Mentioned items are covered, not double surfaced |
| fahrenheit | 101.2 F converted in code |
| uncertain_anticoag | "Not sure if she's on a blood thinner" does not count as mentioned |
| new_oxygen | New oxygen requirement with SpO2 89 |
| stroke_signs | New focal weakness and slurred speech |

**Result: 27 / 27 runs pass (100%).** The clean-call case caught a real negation bug during development ("No fall" was being recorded as a fall); events now carry `occurred` and denied events are dropped in code.

## Run it

Requirements: Node 20+.

```bash
npm run install:all
cp .env.example .env        # add keys: Bedrock (or Anthropic), ElevenLabs, Daytona, Arize, SurrealDB Agent Memory, Anchor
npm run dev                 # client http://localhost:5173, server http://localhost:3001
npm run tunnel              # optional: exposes the mock facility EHR portal so Anchor's cloud browser can reach it
npm run smoke               # checks each sponsor API: PASS / FAIL / SKIPPED
npm run eval                # eval suite
npm run demo:reset          # hides calls signed during rehearsal from prior-call memory
```

`npm run tunnel` needs `tools/cloudflared.exe` (Windows) from the [cloudflared releases](https://github.com/cloudflare/cloudflared/releases/latest). Without Anchor or the tunnel the app uses a local chart copy and still works.

The mock facility EHR portal is at http://localhost:3001/ehr/ (synthetic, demo credentials in `server/src/mockEhr.ts`).

## Repository map

| Path | What |
|---|---|
| `server/src/extract.ts` | Claude fact extraction and quote validation |
| `server/src/safety/rules.ts` | Deterministic red flags (physician reviewed) |
| `server/src/scores.ts` | Baseline, deltas, NEWS2 |
| `server/src/unsaid.ts` | Not yet mentioned / covered on call |
| `server/src/feasibility.ts` | Facility capability tonight |
| `server/src/anchor.ts`, `mockEhr.ts` | Anchor EHR read and note posting, mock facility portal |
| `server/src/memory.ts` | SurrealDB Agent Memory |
| `server/src/ask.ts` | Daytona "Ask the chart" |
| `server/src/note.ts`, `closing.ts` | Draft note, closing lines to the nurse |
| `server/src/instrumentation.ts`, `tracing.ts` | Arize tracing |
| `scripts/eval.ts` | Eval suite |
| `data/` | Synthetic residents, facility, prior calls, call scripts |

## Not a medical device

This is a hackathon prototype for decision support. It surfaces chart information and rule-based flags with visible sources so that the physician can independently review the basis for each, and the physician makes every decision. Production use would require clinical validation, review under FDA clinical decision support guidance, HIPAA-eligible infrastructure with BAAs, and facility authorization for EHR portal access.
