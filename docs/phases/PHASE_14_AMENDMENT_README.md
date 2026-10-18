# Interview flow amendment — resume first, prepared questions, voice and camera self-view

Date: 18 October 2026. Amends the AI interview of Phases 7–10 at the product owner's request
(after Phase 14; this is **not** Phase 15). Requested flow: the resume is added before the
interview; the screen loads, an LLM parses the resume and prepares questions from its projects and
tech stack; only then is Start enabled; questions are spoken; spoken answers are recorded,
transcribed and validated by a separate LLM; the candidate sees their own webcam; the coding round
has its own editor; all answers are stored and turned into one report for the candidate and the
founder.

## What changed

**Resume first, questions prepared before Start.** The readiness screen now has the resume
upload in place (step 1; no detour to the profile) and an "Interview questions" step. After
acceptance — and again whenever the resume changes — the server runs a background preparation:

1. `resume_context` (existing capability): projects, the candidate's own contributions,
   technologies, experience, each backed by a verbatim quote of the redacted resume text.
2. `question_plan` (new capability, interviewer model, prompt `question-plan-v1`): one opening
   question for each of 7 planned topic slots (background, resume project, fundamentals, resume
   project, architecture, problem solving, scenario), grounded in those projects and that tech
   stack plus the role's required skills. Validated strictly: one question per slot in order, the
   slot's type and difficulty range, verbatim resume quotes (required for resume-project
   questions), distinct topics, no near-duplicate prompts. Invalid output is retried and then
   reported as a failure — there is no generic fallback plan.

`POST /interviews/:id/prepare` starts it (idempotent; accept starts it automatically when a resume
exists). The candidate's `readiness.questions` shows `waiting_for_resume`, `preparing` (with the
screen polling), `ready` (count, project names and tech stack found), `stale` (resume replaced:
prepared again automatically) or `failed` (reason + Retry; after 10 failures in a row retries
pause for an hour). `POST /start` returns **409 `PREPARATION_REQUIRED`** until the plan is ready for the
current resume version, and the Start button stays disabled with the reason shown.

**Prepared questions in the interview.** The first question and every new topic come from the
plan; when a new topic is required (start, after a skip, after the follow-up limit) it is asked
immediately with no model call. After a real answer the live interviewer (`interview_turn`,
now `interview-turn-v2` with `plannedNext`) still decides whether to follow up — go deeper, ask
for an example, check understanding — within the existing depth and coverage rules; when it moves
on, the prepared question is asked. Interviews started before this change (no plan) keep
generating every question live.

**Voice.** Questions are read by the server voice (Piper) when the speech service runs, otherwise
by the browser's own speech synthesis — **on-device voices only** (`localService`), so question
text is not sent to an online voice service. Intro and first question are now queued instead of
the question cutting the intro off. "Repeat question" is always available.

**Microphone diagnostics.** Instead of a generic "unavailable", the readiness screen and room say
exactly what is wrong: insecure page (`http://<LAN-IP>` — use https or `http://localhost`),
permission denied, no microphone, microphone busy/blocked by the OS, unsupported browser, or
voice answers off because the speech service is not running / its Whisper model is not loaded /
the candidate chose typed answers. Answers are still recorded, transcribed by the self-hosted
Whisper service, editable, and evaluated after submission by the separate evaluator model
(unchanged).

**Camera self-view.** Optional "Turn camera on" on the readiness screen, in the interview room and
in the coding round: a mirrored, muted `<video>` showing the candidate to themselves. It is
**never recorded, uploaded, sent to the server or analysed** — no face, gaze, emotion or cheating
detection (the no-video-analysis rule stands). The stream is separate from the audio stream,
stopped when the page unmounts or the candidate turns it off; the on/off choice is remembered for
the tab only. The privacy notice and invitation text now say this instead of "your webcam is never
used". The consent policy version is unchanged (`interview-ai-v1`) because no camera data is
processed.

Replacing or deleting the resume while the interview is accepted drops the prepared material
(resume text, context, plan) and stops a running preparation; the screen then prepares again
from the current resume.

**Coding round and report** are unchanged: Monaco editor with visible test runs, hidden tests
after submission, code review by the evaluator model, and one report readable by both
participants.

**Local speech setup.** `npm run speech:setup` (Python 3.9+, free, runs locally) creates the
virtualenv, installs the pinned faster-whisper and Piper packages, downloads the voice and the
Whisper model and writes `SPEECH_PROVIDER=http`, the URL and a generated token into `.env`.
`npm run dev` now also starts the speech service (`scripts/speech-dev.mjs`); when speech is not set
up it prints how to enable it and exits cleanly so the API and web app keep running. `dev` uses
`--kill-others-on-fail` instead of `-k` for that reason.

**Why the microphone "did not work" before.** With `SPEECH_PROVIDER=disabled` (the `.env.example`
default) or the speech service not running, the room silently switched to typed answers and no
question was spoken; opening the app on a LAN address over http also hides the microphone in every
browser. Both cases are now explained on screen, and the browser voice covers spoken questions
without the speech service.

## Data

Interview sessions gain optional `questionPlan` (prepared questions with hidden expected concepts
and model provenance) and `preparedAt`; `resumeRef`/`resumeTextForAi` are now set at preparation
rather than at start. Older records read as "no plan". Retention minimisation clears
`questionPlan` with the other personal content. The founder's view never contains readiness or
prepared prompts, and the candidate's view contains only the count, project names and
technologies — prompts appear one at a time as they are asked; expected concepts never leave the
server.

## Endpoints

`POST /interviews/:id/prepare` (new); `POST /interviews/:id/start` gains 409
`PREPARATION_REQUIRED`; `readiness.questions` on the session view — openapi.yaml 0.14.1.

## Tests

New `apps/server/test/interviews.preparation.test.ts` (14): preparation on acceptance and Start
refused (409 `PREPARATION_REQUIRED`) until ready, one parse and one plan call despite repeated
prepare calls, prompts not exposed before they are asked; plan built from the redacted resume
context (no email, phone or name sent), slot order, resume quotes verbatim, provenance; a
single-project resume still yields distinct questions; no resume → `waiting_for_resume`, 409
`RESUME_REQUIRED`; provider failure and invented resume evidence → `failed`, retry works, never a
generic plan; replaced resume → `stale` → prepared again; prepared questions asked (first and
after a skip with no model call; follow-up stays live; new topics from the plan; expected concepts
and provenance stored); interrupted preparation → retryable; consent withdrawn during preparation
→ cancelled, no plan, and no second AI call after the resume read; deleting the resume during or
after preparation drops resume text, context and plan; failures pause preparation for an hour
instead of locking the candidate out; a prepared question that would repeat an asked one is
skipped; the founder sees no readiness, prompts or preparation activity and gets 403 on prepare.
`test/ai/contracts.test.ts`: plan contract (counts, order, difficulty, invented and missing quotes,
duplicate topics, repeats, strict schema). Conversation tests now exercise the live interviewer on
follow-ups (the first question comes from the plan).

Web: readiness screen — resume upload in place and Start blocked with the reason; automatic
prepare, polling, project and tech-stack display, Start enabled when ready; failed preparation
with Retry; insecure-page microphone message; camera on/off with the stream stopped. Room —
intro and question read in order with the on-device voice only (an online voice is never used);
queued speech stops when leaving the room. `camera.test.tsx`: a stream arriving after the page was
left or after "Turn camera off" is stopped; one stream under StrictMode.

E2E journey: questions ready (7, tech stack shown) before Start; real fake-device camera frames in
the self-view on the readiness screen and in the room; across the whole interview no request body
was video or image (audio uploads were present).

## Verification

Final run, 18 October 2026:

| Suite                                                    | Result                                       |
| -------------------------------------------------------- | -------------------------------------------- |
| `npm run verify` (format, lint, typecheck, tests, build) | pass                                         |
| Server (Vitest, 31 files)                                | 498 passed, 1 skipped (transaction rollback) |
| Shared (Vitest)                                          | 62 passed                                    |
| Web (Vitest + Testing Library)                           | 133 passed                                   |
| E2E (Playwright, Chromium, fake mic and camera)          | 25 passed                                    |
| Speech service (Python)                                  | 8 passed                                     |

Database tests and E2E ran against FerretDB (no transactions; the rollback test is skipped).
`npm run speech:setup -- --skip-models` was run in a scratch copy: virtualenv and pinned packages
installed, `.env` filled without overwriting existing values. `npm run speech:dev` started the real
service; `/healthz` answered and Piper synthesised a 80 KB WAV for an interview question. Model
downloads (Piper voice, Whisper) could not run here because Hugging Face is blocked in this
environment, so **live Whisper transcription and a live Groq call were not verified here**; the
LLM, speech and sandbox in automated tests are the deterministic test doubles.

An independent reviewer reproduced eight issues in the first version, all fixed with regression
tests: camera stream leaked when the page was left during the permission prompt (and twice under
StrictMode); a lifetime cap could lock a candidate out after 10 failed preparations (now a one-hour
pause); resume text, context and plan survived deleting the resume and preparation continued (now
dropped via a resume-change hook and re-checked before each AI call and before commit); a second AI
call after consent withdrawal; queued speech continued after leaving the room; prepared questions
skipped the repeat check (now checked; otherwise generated live); `speech:setup` overwrote `.env`
values and swallowed blank lines; placeholders in this README. A timing-dependent strict-mode
assertion in the Phase 14 E2E test ("Correction requested" matched two elements) was also fixed.

## Limitations

- **Live Whisper transcription and live Groq calls not verified in this environment** (model and
  API hosts blocked); run `npm run speech:setup` and a real interview locally to confirm.
- **MongoDB replica-set transactions still unverified here** (outstanding blocker from Phase 11).
- The browser voice depends on the browser having an on-device English voice (most desktop
  browsers do; some Linux browsers do not). Without one, questions are shown as text only.
- A prepared question keeps the difficulty it was planned with; the live adaptive range applies to
  follow-ups. When a new topic is forced (skip, follow-up limit) the prepared question is asked
  without a model call, so that answer gets no steering signal (used only to choose the coding
  task).
- Preparation runs in the API process; a restart marks it interrupted (retry).
- Voice answers still need the self-hosted speech service; there is no cloud speech-to-text.

## Developer commit plan

Claude did not commit, branch, push or rewrite history. All four developers have changes in
this batch: Dev 1 the new question-plan capability and adaptive use of it, Dev 2 the speech
fallback, microphone diagnostics and speech scripts. Commit in this order, then run
`npm run verify` (intermediate commits do not typecheck on their own):

### Dev 1 — AI question generation and adaptive interviewing

```bash
git add apps/server/src/ai/adapters/mock.ts apps/server/src/ai/adapters/openai-compatible.ts \
  apps/server/src/ai/contracts.ts apps/server/src/ai/prompts.ts apps/server/src/ai/types.ts \
  apps/server/src/interviews/policy.ts apps/server/test/ai/contracts.test.ts \
  docs/architecture/AI_PROVIDER_ARCHITECTURE.md
git commit -m "feat(ai): question_plan capability — resume-grounded questions prepared before the interview"
```

### Dev 3 — backend preparation lifecycle, privacy and tests

```bash
git add packages/shared/src/api.ts packages/shared/src/interview.ts \
  apps/server/src/http/routes/interviews.ts apps/server/src/interviews/records.ts \
  apps/server/src/interviews/service.ts apps/server/src/interviews/view.ts \
  apps/server/src/resumes/service.ts apps/server/test/interviews.conversation.test.ts \
  apps/server/test/interviews.preparation.test.ts apps/server/test/support/interview-fixture.ts \
  docs/api/openapi.yaml docs/phases/PHASE_14_AMENDMENT_README.md
git commit -m "feat(interviews): prepare questions from the resume before start; gate start on the plan"
```

### Dev 2 — speech, voice fallback and local speech service

```bash
git add apps/web/src/features/interviews/audio.ts apps/web/src/features/interviews/player.ts \
  scripts/speech-common.mjs scripts/speech-dev.mjs scripts/speech-setup.mjs \
  services/speech/README.md package.json
git commit -m "feat(speech): mic diagnostics, on-device voice fallback, speech:setup and speech:dev"
```

### Dev 4 — readiness screen, interview room, camera self-view, UI and E2E tests

```bash
git add apps/web/src/features/interviews/PreparePage.tsx \
  apps/web/src/features/interviews/InterviewRoom.tsx \
  apps/web/src/features/interviews/CodingRound.tsx \
  apps/web/src/features/interviews/CandidateInterviewPage.tsx \
  apps/web/src/features/interviews/api.ts apps/web/src/features/interviews/camera.tsx \
  apps/web/src/features/interviews/camera.test.tsx \
  apps/web/src/features/interviews/interviews.test.tsx \
  apps/web/src/features/resume/ResumeSection.tsx e2e/playwright.config.ts \
  e2e/tests/interviews.spec.ts README.md
git commit -m "feat(web): resume-first readiness, prepared-question status, local camera self-view"
```

Afterwards `git status` should be clean.
