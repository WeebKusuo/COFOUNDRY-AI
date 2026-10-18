# AI technical interviews (Phases 7–10)

Supersedes the fixed-anchor text interview of Implementation Contract v3.0 Sections 07–09.
Preserved from v3.0: invitations only from a fresh recommendation batch (MAT-08), 7-day expiry,
one interview per brief/candidate pair, 20 invitations per founder per day, confidentiality
acknowledgement before acceptance, profile snapshot and gate re-check at acceptance (409
`GATE_CHANGED`), brief closing cancels pre-submit interviews, server deadlines that never
extend, durable evaluation, both participants read the report.

```
founder: Candidates → Invite (POST /interviews: fresh batch, listed, same revision, gates pass)
candidate: Inbox → acknowledge brief → accept (consents, profile revision) → Prepare
  readiness: resume (required, no fallback) · microphone · voice check · AI · sandbox
  POST /start ─► in_progress: intro turn (fixed text) + background generation
     ┌──────────────────────────────────────────────────────────────────────────────┐
     │ question (spoken via TTS, shown as text) ─► answer: record ─► /audio (Whisper)│
     │   ─► editable draft ─► /answer (or typed) ─► background interview_turn        │
     │   policy: coverage plan · intent per signal · depth ≤ 2 · one check · no repeat│
     └──── up to 10 questions / 20 minutes / candidate finishes ─────────────────────┘
  coding: AI picks a task from the bank (rule-based fallback) ─► Monaco ─► visible runs (Judge0)
  submit (or auto-submit at the deadline) ─► evaluation job (durable, leased)
     answers ─► communication ─► hidden tests + performance (Judge0) ─► code review ─► report
founder + candidate: report (rubric-computed, evidence-backed, human review)
```

## State machine

| Status                           | Entered by                                    | Leaves by                                                                  |
| -------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| `invited`                        | founder invitation                            | accept, decline, expiry (7 d), cancel, brief closed                        |
| `accepted`                       | acceptance with consents and profile snapshot | start, expiry, cancel, consent withdrawn, brief closed                     |
| `in_progress`                    | start (resume ready, AI configured)           | conversation end/finish/deadline → `coding`; global deadline → `submitted` |
| `coding`                         | conversation end                              | submit, coding or global deadline (auto-submit draft) → `submitted`        |
| `submitted`                      | submission                                    | terminal; `evaluationStatus` none → queued → running → succeeded/failed    |
| `declined`/`expired`/`cancelled` | as above                                      | terminal; minimised after 30 days                                          |

Deadlines: conversation 20 min, coding 20 min (bounded by the global deadline), global 45 min
from start. `reconcileRecord` applies due transitions on every read/write and in the 15-second
sweeper; disconnected time is never added back.

## Concurrency, reconnect and duplicates

- Every session write is one conditional replace on `rev`; conflicting writers re-read.
- Question generation runs in the background under a token and a lease derived from the AI
  timing (2 calls × worst case of `LLM_TIMEOUT_MS` × `LLM_MAX_ATTEMPTS` plus backoff, + 30 s;
  about 4.6 minutes with the defaults); an expired lease (crash) becomes `failed` and the
  candidate can retry. Responses never contain invented questions.
- Finishing the conversation early requires at least one real (non-skipped) answer, enforced by
  the server as well as the UI.
- The coding draft (code **and** explanation) autosaves every 10 s; at the deadline the latest
  draft is submitted. A manual submission that arrives after that gets 409 with an explanation
  instead of being dropped silently.
- One live window: `start`/`attach` set `activeClientId` (per-tab id in `sessionStorage`); other
  windows see `activeElsewhere` and must take over explicitly; stale windows get 409
  `ACTIVE_ELSEWHERE`. Reloading the same tab reconnects to the same question and deadline.
- Evaluation jobs: unique per session, leased claims, steps saved as they finish (retries never
  repeat finished provider calls), exponential backoff, 4 attempts, then `failed` with up to 2
  manual retries (only while assessment consent is active). The job lease covers the slowest
  step (≥ 5 minutes). The sweeper also re-creates the job of any session submitted more than a
  minute ago that is still `queued` without one (a crash between commit and enqueue).
- Withdrawing consent after submission stops an unfinished evaluation for good
  (`evaluationStatus: failed`, no retry).

## Privacy and retention

- Raw answer audio is never stored: it is forwarded to the speech service and discarded.
- The founder sees progress only until submission; afterwards transcripts, code and report —
  unless the candidate withdraws consent (immediate loss of founder access, jobs cancelled).
- Hidden fields never leave the server: expected concepts, hidden tests, reference solutions,
  resume text/context, client ids.
- Declined/expired/cancelled sessions keep minimal status after 30 days; everything is deleted
  18 months after invitation. Reports and jobs are deleted with the session.
- Consent is a durable ConsentRecord (`assessment` per interview, `brief_access` per brief) and
  is re-checked before every AI dispatch and before committing results.

## Modules

| Path                                        | Responsibility                                                    |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `packages/shared/src/interview.ts`          | Statuses, limits, consents, notices, DTOs                         |
| `packages/shared/src/rubric.ts`             | Rubric, aggregation, calibration fixtures                         |
| `packages/shared/src/report.ts`             | Report DTOs                                                       |
| `packages/shared/src/redaction.ts`          | `redactForAi`, `looksLikePromptInjection`                         |
| `apps/server/src/interviews/`               | records, Mongo stores, policy, views, service, evaluation, report |
| `apps/server/src/speech/`                   | STT/TTS interfaces, HTTP client, transcript analysis              |
| `apps/server/src/coding/`                   | task bank, harness/grading, Judge0 adapter                        |
| `apps/server/src/http/routes/interviews.ts` | Routes, limits, raw audio body                                    |
| `apps/web/src/features/interviews/`         | Inbox, invitation, readiness, room, coding, report                |
| `services/speech/`                          | Python speech service                                             |
