# Phase 10 — Final report, scoring rubric and AI reliability

Date: 18 October 2026. Context: [PHASE_07](PHASE_07_README.md), [PHASE_08](PHASE_08_README.md),
[PHASE_09](PHASE_09_README.md). Rubric: [INTERVIEW_SCORING.md](../architecture/INTERVIEW_SCORING.md).
This is the last phase of this delivery; nothing from Phase 11 onwards is implemented.

## Final report

Built once per completed interview by the durable evaluation worker (`interviews/report.ts`) and
stored in `interview_reports` (versioned, with rubric id, prompt versions, model labels, task
version and judge id). Both participants see the same report once it is ready:

- overall technical assessment (number, band, coverage, "insufficient evidence" when coverage
  < 60 %), technical score, coding score, and a **separate** communication score;
- per question: the question, type/intent, the candidate's answer (input mode, transcript
  confidence, edit share), dimension levels with rationale and verbatim quotes, concepts
  demonstrated/missing, incorrect statements, "not assessed" when evidence was insufficient;
- coding: task and version, language, test results (visible/hidden counts only — hidden inputs
  are never shown), compile status, performance check, AI code review with quoted lines and the
  explanation feedback; "Code execution was unavailable" with no coding score when the sandbox is
  disabled;
- strengths and gaps with evidence, uncertainty notes, suspected transcription issues,
  prompt-injection flags for human review, and the rubric/model metadata;
- a fixed notice: the report supports a human decision and never accepts or rejects anyone.

While evaluation runs, `GET /interviews/:id/report` returns a pending view with step progress;
after a final failure it shows the failed step and (to the candidate and founder) a retry action
(at most 2 manual retries). Founders only ever see the report after submission and only while
the candidate's assessment consent is active; withdrawal removes founder access and cancels
pending evaluation. UI: `ReportView.tsx` (responsive, checked on a 390 px viewport in E2E).

## Rubric and calibration

`rubric-interview-v1` in `packages/shared/src/rubric.ts`: technical dimension weights
0.30/0.20/0.15/0.15/0.10/0.10, coding 0.60 tests / 0.15 performance / 0.25 review, overall
0.60 technical / 0.40 coding, bands ≥ 75 strong, ≥ 50 mixed. Weights are converted to integer
micro-units so results are exact (no 74.99999). Models never output totals; every number is
computed on the server from evidence-checked levels. `RUBRIC_CALIBRATION_FIXTURES` lists inputs
and expected outputs; `packages/shared/test/interview.test.ts` reproduces each one. The weights
are a documented starting configuration, **not** empirically validated — calibrate them against
human-reviewed interviews and publish a new rubric version when changing them.

## AI reliability

- Provider layer (`apps/server/src/ai`): six capabilities split between an interviewer model and
  a separately configured evaluator model; consent checked on every call; strict JSON schemas
  plus semantic validators; retries with exponential backoff that honour `Retry-After` and
  rate-limit codes (`LLM_MAX_ATTEMPTS`); per-call timeout and cancellation; response bodies
  capped.
- Durable jobs: `evaluation_jobs` are leased, each step's result is saved as it completes
  (answers, communication, coding tests, code review, report), so a crash or retry never repeats
  finished steps. Up to 4 automatic attempts with backoff 10 s × 4^(n−1), then 2 manual retries.
- Idempotency: invitations use Idempotency-Key; every session write is a conditional replace on
  `rev`; question generation runs under a token and a lease derived from the AI timeout and retries; reports are unique per
  session+version.
- Logs are metadata only (capability, model, prompt version, attempts, duration, status) —
  never prompts, answers, code, transcripts or audio.
- `mock` providers exist for tests and E2E only and are refused when `NODE_ENV=production`.

## Tests (counts from the final run)

| Suite                                    | Tests |
| ---------------------------------------- | ----: |
| Server (Vitest, 26 files)                |   425 |
| Shared (Vitest)                          |    62 |
| Web (Vitest + Testing Library)           |   115 |
| Speech service (Python unittest)         |     8 |
| E2E (Playwright, Chromium, 7 spec files) |    22 |

Server tests run against a real MongoDB-protocol server (FerretDB) for the integration files.
The full E2E journey covers invite → acknowledge → accept → readiness → spoken intro → voice
answer via a fake microphone → follow-up → coding round in Monaco under the production CSP →
submission → evaluation → report for candidate and founder, using mock AI/speech/judge
providers.

## Independent review

A separate review pass (no access to the build reasoning) checked Phases 7–10 and reproduced
these defects, all fixed with regression tests:

1. Coding autosave never fired (the interval was recreated by the 1-second countdown); the
   explanation was not autosaved. Fixed; fake-timer web test.
2. A Judge0 internal error was scored as failed tests. Now a sandbox fault: retried, then
   `failed` with no coding score; visible runs return 503 and refund the run.
3. A crash between submission and job enqueue left evaluation "in progress" forever. The
   sweeper now re-creates missing jobs.
4. Blank code was "not assessed" instead of scoring 0 like no submission.
5. Another founder could probe whether a brief/candidate pair existed (409 vs 404). Ownership is
   checked first.
6. One-word evidence quotes were accepted; quotes must now be substantial.
7. Fixed 2-minute generation lease could expire during legitimate retries; leases are derived
   from the AI timeout and retry budget (evaluation lease covers the slowest step).
8. Finishing the conversation with no answers was only blocked in the UI; now on the server.
9. Answers without correctness evidence are labelled "not assessed" and counted as such.
10. Retry after consent withdrawal was allowed, and withdrawal during evaluation left
    `running`; both fixed.
11. Hidden test names were shown in reports; now "Hidden check n".
12. A late manual submission was silently replaced by the auto-submitted draft; now 409 with an
    explanation.
13. The CSP nonce hook was installed after Monaco's modules evaluated (latent); now a first
    side-effect import.

## Verified integrations, blockers and limitations

| Integration                  | Status                                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Piper TTS                    | **Verified live** through the speech service from the backend client (CPU)                                                                         |
| faster-whisper (decode, VAD) | Library and audio decoding verified live; **transcription not verified** (models on Hugging Face unreachable)                                      |
| Groq LLM                     | **Not verified** — unreachable here and no API key; adapter tested against a local HTTP stub                                                       |
| Judge0 sandbox               | **Blocker** — no sandbox could be started; execution is disabled by default (503, no coding score)                                                 |
| MongoDB transactions         | **Outstanding blocker** — tests ran on FerretDB with `MONGODB_TEST_EXPECT_TRANSACTIONS=false`; FerretDB does not validate replica-set transactions |
| Video analysis               | Not implemented (by specification); the camera is never requested                                                                                  |

Other limitations: rate-limit counters and the TTS cache are per process; Monaco adds ~0.7 MB
gzip (lazy-loaded); PII redaction is best-effort minimisation, not anonymisation; the rubric is
uncalibrated; general brief access outside an invitation is not implemented.

## Developer commit plan

Claude did not commit, branch or push. Each developer reviews and commits only their own files.
Recommended order (later commits depend on earlier ones; intermediate commits may not build on
their own): **Dev 3 → Dev 1 → Dev 2 → Dev 4**. Run `npm run verify` after the last commit.

### Dev 3 — backend, interview lifecycle, persistence, security, sandbox integration

```bash
git add packages/shared/src/interview.ts packages/shared/src/report.ts packages/shared/src/api.ts \
  packages/shared/src/index.ts packages/shared/test/phase4.test.ts \
  apps/server/src/interviews/records.ts apps/server/src/interviews/store.ts \
  apps/server/src/interviews/service.ts apps/server/src/interviews/view.ts \
  apps/server/src/coding/judge.ts apps/server/src/coding/index.ts \
  apps/server/src/config/env.ts apps/server/src/db/migrations.ts apps/server/src/index.ts \
  apps/server/src/http/app.ts apps/server/src/http/routes/v1.ts apps/server/src/http/routes/interviews.ts \
  apps/server/src/http/routes/briefs.ts apps/server/src/http/middleware/security.ts \
  apps/server/src/http/middleware/request-context.ts apps/server/src/http/static-web.ts \
  apps/server/src/briefs/service.ts apps/server/src/recommendations/service.ts \
  apps/server/test/interviews.lifecycle.test.ts apps/server/test/interviews.integration.test.ts \
  apps/server/test/support/memory-interview-store.ts apps/server/test/support/interview-fixture.ts \
  apps/server/test/support/harness.ts apps/server/test/helpers.ts apps/server/test/app.test.ts \
  apps/server/test/config.test.ts apps/server/test/db.integration.test.ts \
  apps/server/test/resumes.test.ts apps/server/test/static-web.test.ts \
  e2e/start-server.ts scripts/package-zip.mjs .env.example docs/api/openapi.yaml \
  docs/architecture/INTERVIEWS.md docs/architecture/CODE_EXECUTION.md docs/phases/PHASE_07_README.md
git commit -m "feat(interviews): invitation lifecycle, secure sessions, persistence and Judge0 integration (Phases 7-10)"
```

### Dev 1 — AI question generation, adaptive interviewing, technical evaluation

```bash
git rm apps/server/src/interviews/resume-question-input.ts
git add apps/server/src/ai/contracts.ts apps/server/src/ai/prompts.ts apps/server/src/ai/adapters/mock.ts \
  apps/server/src/interviews/policy.ts apps/server/src/interviews/resume.ts \
  apps/server/src/interviews/report.ts \
  packages/shared/src/rubric.ts packages/shared/src/redaction.ts packages/shared/test/interview.test.ts \
  apps/server/test/ai/contracts.test.ts apps/server/test/interviews.conversation.test.ts \
  docs/architecture/INTERVIEW_SCORING.md docs/phases/PHASE_08_README.md
git commit -m "feat(ai): adaptive resume-based questioning, evidence-checked technical evaluation and rubric"
```

### Dev 2 — Whisper, TTS, coding evaluation, AI reliability

```bash
git add services/speech apps/server/src/speech/types.ts apps/server/src/speech/services.ts \
  apps/server/src/coding/tasks.ts apps/server/src/coding/grading.ts \
  apps/server/src/ai/invoke.ts apps/server/src/ai/errors.ts apps/server/src/ai/types.ts \
  apps/server/src/ai/registry.ts apps/server/src/ai/index.ts \
  apps/server/src/ai/adapters/openai-compatible.ts apps/server/src/ai/adapters/disabled.ts \
  apps/server/src/ai/transport/http-json.ts apps/server/src/interviews/evaluation.ts \
  apps/server/test/speech.test.ts apps/server/test/coding.test.ts \
  apps/server/test/ai/registry-invoke.test.ts apps/server/test/ai/openai-compatible.test.ts \
  apps/server/test/interviews.evaluation.test.ts .gitignore \
  docs/architecture/AI_PROVIDER_ARCHITECTURE.md docs/phases/PHASE_09_README.md
git commit -m "feat(speech,coding): faster-whisper/Piper service, coding grading and durable AI evaluation"
```

### Dev 4 — interview room, Monaco coding UI, final report dashboard

```bash
git add apps/web/src/features/interviews apps/web/src/lib/csp-nonce.ts apps/web/src/lib/csp-nonce-install.ts apps/web/src/lib/api/client.ts \
  apps/web/src/app/routes.tsx apps/web/src/app/app.test.tsx \
  apps/web/src/features/recommendations/CandidateCard.tsx \
  apps/web/src/features/recommendations/RecommendationsPage.tsx \
  apps/web/src/features/recommendations/recommendations.test.tsx \
  apps/web/package.json apps/web/vite.config.ts package.json package-lock.json \
  e2e/playwright.config.ts e2e/tests/interviews.spec.ts e2e/tests/recommendations.spec.ts \
  e2e/tests/responsive.spec.ts README.md docs/phases/PHASE_10_README.md
git commit -m "feat(web): interview room, Monaco coding round and final report dashboard"
```

Afterwards `git status` should show a clean tree.
