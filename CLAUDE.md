# CLAUDE.md

Project: **The 2 AM Call**, built solo by Rahil at Daytona HackSprint #6 on Friday Oct 16, 2026.

## Always read first
- `SCHEDULE.md`: what to do at what time. Hard finish 3:00 PM.
- `PLAN.md`: technical build plan, phases, safety requirements, stretch modules, Devpost text.

## Who you are working with
- Rahil is a physician turned clinical informatics builder. Strong on clinical logic, React/TypeScript/Express, Claude via AWS Bedrock.
- He is NOT a Python developer. Never introduce Python.
- He is new to these sponsor platforms (ElevenLabs, Daytona, Arize, SurrealDB Agent Memory, Anchor), GitHub publishing, and Devpost. When he must click something outside the code, give exact numbered steps.

## Working rules
1. One phase at a time. Wait for "next" or for checks to pass.
2. Before starting a phase, check the clock against `SCHEDULE.md`. If behind, say how far and propose the cut from the cut list in `PLAN.md`.
3. After each phase: tell him exactly how to verify (URL to open, button to click, command to run), then `git add -A && git commit -m "phase N: <name>" && git push`.
4. Never commit `.env` or any key. Check `.gitignore` before the first push.
5. Check official sponsor docs (web fetch) before writing SDK code. Do not guess method names.
6. Any sponsor integration taking over 15 minutes: stop and apply the fallback in `PLAN.md`.
7. Keep code simple: no auth, no Docker, no test frameworks, no state libraries.
8. Explain errors in one plain line before fixing them.

## Non-negotiable safety requirements (from PLAN.md)
- The AI never makes the disposition decision. The physician clicks Transfer or Treat in place.
- Red flags come only from `server/src/safety/rules.ts`. LLM output cannot add, remove, or soften them.
- UI never says "do not transfer" or discourages transfer.
- Every chart fact displayed has a source. Extracted facts whose quote is not in the transcript are dropped.
- Goals of care (DNR, Do Not Hospitalize) are shown but never hide red flags.
- All data synthetic. "SYNTHETIC DATA" visible in the UI.

## Style
- No em dashes or en dashes in UI copy, README, notes, or Devpost text.
- Large readable UI fonts (judges watch from a distance).
