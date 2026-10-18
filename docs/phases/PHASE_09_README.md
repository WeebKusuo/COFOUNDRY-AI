# Phase 09 — Technical evaluation and practical coding round

Date: 18 October 2026. Context: [PHASE_07_README](PHASE_07_README.md). Scoring:
[INTERVIEW_SCORING.md](../architecture/INTERVIEW_SCORING.md). Sandbox:
[CODE_EXECUTION.md](../architecture/CODE_EXECUTION.md).

## Technical answer evaluation

A separately configured evaluator model (`LLM_EVALUATOR_MODEL`, e.g. Groq `openai/gpt-oss-120b`)
evaluates each answered question with: the question, type, difficulty, hidden expected concepts,
resume quote, role skills, the redacted answer (input mode, transcript confidence, unclear
segments, edited flag) and the parent follow-up chain (≤ 2, redacted). Output (strict JSON):
six dimensions — correctness, relevance, reasoning, practical understanding, specificity/depth,
consistency — each level 0–4 **or null** with rationale and 1–3 verbatim quotes; concepts
demonstrated/missing; incorrect statements with quotes; strengths with quotes; gaps marked
`incorrect` or `missing_evidence`; uncertainty; suspected transcription issues.

The server keeps only quotes found in the answer; a level left without a quote becomes null
("insufficient evidence"), uncertainty is raised and the count is reported. Strengths and
incorrect statements without a real quote are dropped. Models never output totals: schemas are
strict, so `{"overallScore": 100}` is invalid output.

## English communication (separate)

One call over all spoken/typed answers: clarity, structure, technical explanation, reasoning
communication and grammar (lenient), each 0–4/null with quotes, plus feedback and suggestions.
The prompt forbids penalising accent, non-native phrasing, filler words, transcription errors or
speaking style; the score is shown on its own and never enters a technical or coding number.

## PII and prompt-injection protection

`redactForAi` (shared, deterministic, linear-time) removes emails, phones, links/profile URLs,
private keys, connection-string credentials, AWS/GitHub/Groq/OpenAI-style tokens, JWTs, bearer
tokens, `password=`/`api_key:` values, PAN/Aadhaar/SSN numbers, labelled personal fields (Name,
Address, Date of birth, …) and the participant's known name(s) — full names case-insensitively,
single words only with exact capitalisation and ≥ 3 letters so technical words survive. It is
applied to resume text, every answer and submitted code before any external call. **This is
best-effort minimisation, not anonymisation**: free-text names of other people, unlabeled
addresses and unusual identifiers can remain (the consent notice says so and asks candidates
not to include personal data). Provider retention: requests already sent cannot be recalled and
the provider's own terms apply; this is disclosed before consent.

Prompt injection: fixed system prompts; candidate content only inside a JSON `data` field;
strict output validation, evidence checks and server-side policy/aggregation; heuristic flags
for instruction-like text in the resume, answers or code (shown in the report for human review).
API keys, environment variables and system prompts are never included in any model input.

## Coding round

- Task selection: the interviewer model picks one task from the versioned bank
  `coding-tasks-v1` (validated id); if it is unavailable a deterministic skill-overlap rule picks
  one and the report says so. Tasks (JavaScript and Python starters):
  `dedupe-events` (fix a bug), `parse-query` (edge cases), `sliding-window-limit` (complete a
  function, performance check), `merge-bookings` (improve inefficient code, performance check).
  Every expected value is verified against a trusted reference implementation in tests.
- UI: task, visible tests, language selector, **Monaco Editor** (bundled locally, lazy-loaded,
  ~0.7 MB gzip, with a plain-text fallback for screen readers), "Run visible tests" with results
  and diagnostics, explanation, confirmed submission, countdown, autosave every 10 s (code and explanation),
  auto-submit of the saved draft at the deadline. Submission stores the code artefact (no Git).
- CSP: Monaco's runtime `<style>` elements get a per-response nonce injected into the SPA shell
  (`style-src 'self' 'nonce-…'`); inline style **attributes** are allowed for its line layout
  (`style-src-attr 'unsafe-inline'`). Scripts stay `'self'` only. Verified in the E2E run with
  zero CSP violations.

## Secure execution

Only a self-hosted Judge0 CE instance executes code: 5 s CPU (3 s for performance checks), 10 s
wall, 256 MB memory, 64 MB stack, 60 processes, 1 MB files, `enable_network: false`, output
capped; 6 runs/min per user and 30 per interview. Expected values never enter the sandbox;
outputs are compared on the server after a random per-run marker (forged prints cannot pass).
Hidden tests and the performance check run during evaluation; results are stored with the task
version and judge id. Reports list hidden tests only as "Hidden check n" (their names describe
the inputs). A Judge0 internal error is treated as a sandbox fault, never as the candidate's
failure: a visible run returns 503 and the run is given back; during evaluation the job retries,
and a fault that persists is reported as "sandbox failed" with no coding score.

**Blocker:** a secure sandbox could not be demonstrated here (container/namespace startup was
refused by the environment, Judge0 hosts are unreachable). Execution is therefore **disabled by
default**: runs return 503 with an explanation, reports show "Code execution was unavailable" and
no coding score. There is no unsafe local fallback. Deploy Judge0 as documented to enable it.

## Coding evaluation

1. deterministic visible + hidden tests (functional score); 2. compile/syntax status; 3.
   correctness via exact JSON comparison; 4. performance check on a large generated input; 5. a
   separate LLM code review (readability, approach, edge cases; quoted code; issues with line
   numbers bounded to the file) and feedback on the explanation. The review never decides
   correctness and never scores alone.

## Tests

- `coding.test.ts` (28): every expected value against the reference; hidden edge cases and
  performance checks exist; rule-based fallback; harness programs run **only trusted reference
  and starter code** locally in node/python3 to prove the generated harness, including the
  performance checks; missing-function message; forged output cannot pass and expected values
  never enter the sandbox; Judge0 adapter request (network disabled, limits, base64, auth token),
  status mapping, outage handling; disabled judge refuses.
- `interviews.evaluation.test.ts` (8): AI task selection, hidden tests not exposed, visible runs,
  compile errors; execution disabled → 503 and no coding score; auto-submit; full evaluation →
  rubric-computed report for both participants; durable retries without repeating finished
  steps and manual retry; fabricated evidence downgraded; consent withdrawal stops founder
  access and cancels evaluation; skipped questions score 0.
- `packages/shared/test/interview.test.ts`: PII redaction (incl. hostile-input timing),
  injection heuristics. Web: coding round with visible runs and confirmed submission. E2E:
  Monaco under the production CSP, sandbox run (mock judge), submission.
