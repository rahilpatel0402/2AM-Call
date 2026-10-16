# The 2 AM Call: Minute by Minute Runbook (start 10:30, finish 3:00)

This file is for Rahil AND for Claude Code. Claude Code: when Rahil asks "what now?", check the clock, find the current block here, and walk him through it step by step. He is new to these sponsor platforms, GitHub publishing, and Devpost, so give exact clicks and commands, one step at a time.

Hard rule: everything is finished and submitted by 3:00 PM. Devpost closes at 3:30 PM; we do not use that last half hour.

---

## Files in this repo

| File | What it is |
|---|---|
| `CLAUDE.md` | Rules Claude Code follows automatically every session |
| `SCHEDULE.md` | This file. What to do at what time, with beginner steps |
| `PLAN.md` | The technical build plan, phase by phase |

## The day at a glance

| Time | Block | Keys needed by then |
|---|---|---|
| 10:30 to 10:45 | Phase 0: Scaffold + repo + Claude key | AWS or Anthropic |
| 10:45 to 11:05 | Phase 1: Synthetic data + memory | SurrealDB Agent Memory (fallback ok) |
| 11:05 to 11:40 | Phase 2: Transcript (replay, then live mic) | ElevenLabs |
| 11:40 to 12:20 | Phase 3: Fact extraction + "What wasn't said" | none new |
| 12:20 to 12:35 | Lunch at desk | Get Daytona + Arize keys while eating |
| 12:35 to 1:15 | Phase 4: Safety rules + scores + facility + prior calls | none new |
| 1:15 to 1:45 | Phase 5: Arize + Daytona | Daytona, Arize |
| 1:45 to 2:05 | Phase 6: Note + eval | none new |
| 2:05 to 2:30 | Phase 7: README + demo video | YouTube or Loom login |
| 2:30 to 3:00 | BUFFER: Devpost submit + slides + rehearse | Devpost login |

Gate checks: **12:20** (behind? cut live mic) and **1:55** (ahead? one stretch module).

---

## 10:30 to 10:45  |  Phase 0: Scaffold + repo + Claude key

Work in parallel: Claude Code builds the scaffold while you set up GitHub and the Claude key.

### Step 1. Laptop check (1 min)
In VS Code: menu **Terminal > New Terminal**, run:
```
node -v
git --version
```
Node must be 20 or higher (install LTS from nodejs.org if not). Git must print a version (install from git-scm.com if not).

### Step 2. GitHub repo (4 min)
1. github.com > sign in > "+" (top right) > **New repository**.
2. Name `two-am-call`. Select **Public**. Check "Add a README file". Click **Create repository**.
3. Green **Code** button > copy the HTTPS URL.
4. In the VS Code terminal:
```
cd ~/Desktop
git clone <paste URL>
cd two-am-call
code .
```
5. A new VS Code window opens on the repo. Drag `CLAUDE.md`, `SCHEDULE.md`, `PLAN.md` into its file explorer (left panel).

### Step 3. Start Claude Code (1 min)
Open the Claude Code panel in the new window and type:
> Read CLAUDE.md, SCHEDULE.md, and PLAN.md. Then do Phase 0 only. Walk me through anything I need to click, and show me how to verify it when done.

Let it work while you do Step 4.

### Step 4. Claude key (5 min max, start with AWS)
**Option A, AWS lab account:**
1. Click the organizers' AWS lab link, enter your email, use the one-time password from your inbox.
2. On the lab landing page, look for "AWS details" or "Command line or programmatic access". Copy Access key ID, Secret access key, Session token, and the region.
3. In the console, search **Bedrock** > **Model access** / **Model catalog**. Confirm a Claude Sonnet model is available. Copy its model ID (it may start with `us.anthropic.`).
4. Stuck after 5 minutes? Ask an AWS judge (Sam Farber or Siddhesh Kumbhare), and meanwhile use Option B.

**Option B, Anthropic API key (always works):** console.anthropic.com > API Keys > Create key. Set `LLM_PROVIDER=anthropic`.

### Step 5. Fill `.env` (2 min)
When Claude Code has created `.env.example`, run `cp .env.example .env`, open `.env`, paste the Claude values. Leave the other keys empty for now; you will add each one right before it is needed.

### Done when
- `npm run dev` shows the page header "The 2 AM Call | SYNTHETIC DATA" at `http://localhost:5173`
- Smoke test prints PASS for Claude (other sponsors can FAIL for now)
- Tell Claude Code "commit and push". On github.com, files are there and `.env` is NOT.

---

## 10:45 to 11:05  |  Phase 1: Synthetic data + memory

### First (5 min): SurrealDB Agent Memory key
1. Open the organizers' Agent Memory credit link, sign in to SurrealDB Cloud.
2. Create an Agent Memory **context** named `two-am-call`, then create an API key for it.
3. Paste into `.env`: `SPECTRON_ENDPOINT`, `SPECTRON_CONTEXT`, `SPECTRON_API_KEY` (Spectron is the old product name).
4. Not working in 5 minutes? Tell Claude Code "use the in-memory fallback for Agent Memory, we wire it later". Ask Martin Schaer (SurrealDB judge) for help at lunch.

### Then
Tell Claude Code: **"Do Phase 1."**
**Your clinical job (5 min):** read the 3 resident files and 3 call scripts. Fix anything a real SNF nurse would not say. This is what makes the demo believable.

**Checkpoint:** open `http://localhost:3001/api/residents/res_joseph/memory`. You see 2 prior calls.
Then: "commit and push".

---

## 11:05 to 11:40  |  Phase 2: Transcript

### First (3 min): ElevenLabs key
elevenlabs.io > log in > redeem the Creator plan offer if you got a code > profile (bottom left) > **API Keys** > Create (allow Speech to Text and Text to Speech) > copy into `.env` as `ELEVENLABS_API_KEY`. Restart `npm run dev`.

### Then
Tell Claude Code: **"Do Phase 2. Replay first."**
- **By 11:20:** open `http://localhost:5173`, choose Margaret, click Replay. Lines stream in.
- **By 11:40:** click Live, allow the microphone when the browser asks, speak. Text appears.

Live mic not working at 11:40? Say "leave live mode, move to Phase 3". Retry only in the buffer.
Then: "commit and push".

---

## 11:40 to 12:20  |  Phase 3: Fact extraction + "What wasn't said"

Tell Claude Code: **"Do Phase 3."**
**Checkpoint:** Margaret replay shows "Anticoagulant: apixaban" in the amber card. Joseph replay shows MOLST Do Not Hospitalize.
Then: "commit and push".

### 12:20 GATE CHECK
- On time: lunch, then Phase 4.
- 15+ minutes behind: say "We are behind. Apply cut list item 4 (live mic) and simplify Phase 4 to rules + NEWS2 only."

---

## 12:20 to 12:35  |  Lunch at desk + two keys

While eating, get the keys for Phase 5:
1. **Daytona:** app.daytona.io > sign up > redeem the $100 coupon (Billing / Wallet) > **Keys** > Create > `.env` as `DAYTONA_API_KEY`.
2. **Arize:** app.arize.com > create free account > Settings (gear) > copy **Space ID** and create an **API Key** > `.env` as `ARIZE_SPACE_ID`, `ARIZE_API_KEY`.
3. Run Joseph replay once and write down anything clinically wrong.

---

## 12:35 to 1:15  |  Phase 4: Safety rules, scores, facility, prior calls

Tell Claude Code: **"Do Phase 4."**
**Your clinical job (5 min):** review `server/src/safety/rules.ts` line by line. These thresholds are the most important thing in the project.
**Checkpoint (all three must pass):**
- Margaret: fall + anticoagulant red flag, "CT head not available tonight"
- Joseph: no red flags, facility green, "3rd call this week"
- Dorothy: hypotension + tachycardia flags fire

Then: "commit and push".

---

## 1:15 to 1:45  |  Phase 5: Arize + Daytona

Tell Claude Code: **"Do Phase 5."** Hard cap 15 minutes each; over that, apply the PLAN.md fallback.
**Checkpoint:**
- app.arize.com > project `two-am-call` > Traces: a session for your last call
- In the app, "Ask the chart" for Dorothy: "trend her creatinine" returns numbers

Then: "commit and push".

---

## 1:45 to 2:05  |  Phase 6: Note + eval

Tell Claude Code: **"Do Phase 6."**
**Checkpoint:**
- `npx tsx scripts/eval.ts` prints all PASS. Screenshot the table (Mac: Cmd+Shift+4 and drag; Windows: Win+Shift+S).
- Sign a Joseph note, start a new Joseph call: the signed call appears in Prior Calls. This is your SurrealDB moment.

Then: "commit and push".

### 1:55 GATE CHECK (resource boost)
Only if Phase 6 is fully DONE by 1:55: say **"Do stretch module S1 (ElevenLabs voice brief). Hard stop 2:10."**
Otherwise skip it. S2 and S3 are for another day; Phase 7 matters more for Round 1 judging.

---

## 2:05 to 2:30  |  Phase 7: README + demo video

### 2:05 to 2:12  README
Tell Claude Code: **"Do Phase 7 README, then commit and push."** Check it on github.com.

### 2:12 to 2:25  Video (under 2 minutes, aim 1:45)
**Mac:** Cmd+Shift+5 > Record Entire Screen > Options > Microphone: MacBook Microphone > Record. Stop with the menu bar stop button. File lands on Desktop.
**Windows:** Win+Alt+R (Xbox Game Bar), or loom.com (free, gives a link instantly).

Script:
1. (0:00 to 0:15) "At 2 AM a nursing home nurse calls a doctor who has never met the patient. Key facts go unsaid. This is The 2 AM Call."
2. (0:15 to 0:50) Margaret replay: apixaban appears, red flags, CT not available tonight.
3. (0:50 to 1:20) Joseph replay: no red flags, Do Not Hospitalize surfaced, facility can treat tonight, 3rd call this week. Treat in place, sign. New call: remembered.
4. (1:20 to 1:35) Eval table + Arize trace.
5. (1:35 to 1:45) "The AI never decides. It makes sure the doctor knows. Built with ElevenLabs, AWS Bedrock, Daytona, Arize, and SurrealDB."

One take. No editing.

### 2:25 to 2:30  Upload
youtube.com > Create (camera icon) > Upload video > Visibility **Unlisted** > copy link. (Or copy the Loom link.)

---

## 2:30 to 3:00  |  BUFFER + SUBMIT

### 2:30 to 2:45  Devpost
1. Open the organizers' submission link > log in / sign up > **Join hackathon** > **Create project** (or "Enter a submission").
2. **Title:** The 2 AM Call
3. **Tagline:** AI that listens to the 2 AM nurse call and shows the on-call doctor what wasn't said.
4. **Description:** paste the "Devpost text" section from PLAN.md. Put in your real eval pass rate.
5. **Built with:** TypeScript, React, Node.js, Express, AWS Bedrock, Claude, ElevenLabs, Daytona, Arize, SurrealDB.
6. **Repo link:** your GitHub URL. **Video:** your YouTube/Loom link.
7. **Gallery:** 2 screenshots (Margaret red flags, eval table).
8. **Team:** just you. Make sure your profile has email, LinkedIn, GitHub.
9. Click **Submit** on the final step ("Save" is not submitting). Screenshot the confirmation.

### 2:45 to 3:00  Slides + rehearse
- Paste the slide text from PLAN.md into Google Slides (5 slides, big fonts, screenshots on slides 3 and 4).
- Rehearse the 3 minute pitch once with a phone timer. Read the Q&A prep once.

### 3:00  DONE.

---

## After submission (3:30 to 5:00)

- 3:30: finalists announced. If you are in: app running, laptop charged, mic tested, backup video open in a tab. Ask someone at your table to read the nurse lines, or use replay.
- 4:00 pitch: if the live demo stalls for more than 10 seconds, say "here is the recorded run" and play the video. Do not debug on stage.
- Not a finalist? Best Use awards come from all teams. Find the SurrealDB, Arize, Daytona, and ElevenLabs judges and give each a 60 second demo of their tool in your app.

---

## If something breaks (what to tell Claude Code)

| Problem | Say this |
|---|---|
| Any error you don't understand | "Here is the error: <paste>. Explain in one line, then fix it." |
| Stuck on one sponsor over 15 min | "Apply the fallback for <sponsor> from PLAN.md and move on." |
| App won't start | "Run npm run dev and fix whatever errors appear." |
| Git push rejected | "My git push failed with: <paste>. Fix it." |
| Behind schedule | "We are N minutes behind. What should we cut from the cut list?" |
| Lost track | "What time block are we in per SCHEDULE.md, and what is left?" |
