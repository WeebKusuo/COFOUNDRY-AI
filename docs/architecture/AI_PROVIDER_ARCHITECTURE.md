# AI provider architecture

Status: Phases 7–10 plus the interview-preparation amendment. The interview uses seven LLM capabilities behind one provider abstraction,
plus separate interfaces for speech-to-text, text-to-speech and code execution. Every provider is
replaceable by configuration, and every one defaults to `disabled`.

**No video analysis.** There is no face, gaze, posture, emotion, nervousness, confidence or
cheating inference from video or audio. The optional camera self-view is rendered only in the
candidate's browser (a muted `<video>` element); it is never recorded, uploaded or analysed.

## Shape

```
business code ──► invokeCapability(registry, capability, input, {timeoutMs, outputSchema, consent, validate, retry})
                         │  consent (assessment + external processing) ─► consent_missing
                         │  per-attempt timeout + outer cancellation   ─► timeout / cancelled
                         │  adapter.run(input, ctx)                     ─► raw JSON + token usage
                         │  strict zod schema, no clamping or repair    ─► invalid_output
                         │  semantic checks (evidence, interview policy) ─► invalid_output
                         │  retry with exponential backoff (honours 429 Retry-After)
                         ▼
                  ProviderResult<T> = {ok:true, value, meta} | {ok:false, error, meta}
```

| File (`apps/server/src/ai/`)    | Purpose                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `types.ts`                      | Capabilities, inputs, `CapabilityAdapter`, `ProviderResult`, consent proof      |
| `registry.ts`                   | `AiProviderRegistry`, factories `disabled`, `groq`, `openai-compatible`, `mock` |
| `invoke.ts`                     | The single call path: consent, timeout, validation, retries, metadata-only logs |
| `prompts.ts`                    | Fixed system prompts (versioned); candidate content only as JSON data           |
| `contracts.ts`                  | Output schemas, evidence checks, interview-policy checks, similarity            |
| `adapters/openai-compatible.ts` | Groq / vLLM / llama.cpp / Ollama chat-completions with JSON mode                |
| `adapters/mock.ts`              | Deterministic test double (tests and E2E only; refused in production)           |
| `adapters/disabled.ts`          | Production-safe default                                                         |

| Other interface             | Implementation                                                           |
| --------------------------- | ------------------------------------------------------------------------ |
| `src/speech` `SpeechToText` | faster-whisper in `services/speech` (HTTP, bearer token); disabled; mock |
| `src/speech` `TextToSpeech` | Piper in `services/speech`; disabled; mock                               |
| `src/coding` `CodeJudge`    | Judge0 CE (self-hosted); disabled (default); mock (never executes code)  |

## Capabilities

| Capability                 | Model       | Output (validated)                                                      |
| -------------------------- | ----------- | ----------------------------------------------------------------------- |
| `resume_context`           | interviewer | skills, projects, experience, achievements — each with a verbatim quote |
| `question_plan`            | interviewer | one opening question per planned topic slot (before start), quotes      |
| `interview_turn`           | interviewer | steering signal for the last answer + next question (type, intent, …)   |
| `coding_task_selection`    | interviewer | one task id from the fixed bank + reason                                |
| `answer_evaluation`        | evaluator   | six dimensions 0–4/null with quotes, concepts, gaps, uncertainty        |
| `communication_evaluation` | evaluator   | five communication dimensions 0–4/null with quotes, feedback            |
| `code_review`              | evaluator   | readability, approach, edge cases 0–4/null with code excerpts, issues   |

Models never produce aggregates: schemas are strict objects (an extra `score` key is rejected)
and the backend computes everything from `packages/shared/src/rubric.ts`.

## Chosen providers and licences (verified 18 October 2026)

| Role           | Default (env-configurable)                  | Licence                                                   | Notes                                                                                    |
| -------------- | ------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Interviewer    | Groq `llama-3.3-70b-versatile` (production) | Llama 3.3 Community Licence (open weights, AUP, 700M MAU) | Free tier ≈ 30 RPM, 1K requests/day, small tokens/minute (third-party figure, Apr 2026)  |
| Evaluator      | Groq `openai/gpt-oss-120b` (production)     | Apache-2.0                                                | Free tier 30 RPM, 1K RPD, 8K TPM, 200K TPD (Groq docs)                                   |
| Speech-to-text | faster-whisper 1.2.1 + Whisper `small.en`   | MIT / MIT                                                 | CPU int8 ≈ 1.5 GB RAM; ~8× real time on 8 threads (project benchmark)                    |
| Text-to-speech | Piper 1.8.0 + `en_US-ljspeech-medium` voice | GPL-3.0 engine (separate process) / public-domain dataset | Faster than real time on CPU; avoid voices whose dataset licence is restrictive (lessac) |
| Code execution | Judge0 CE ≥ 1.13.1                          | GPL-3.0 (separate network service)                        | Docker + privileged isolate sandbox on a dedicated host                                  |
| Code editor    | Monaco Editor 0.56.0                        | MIT                                                       | Bundled locally (CSP forbids CDNs); dompurify pinned to 3.4.16 via `overrides`           |

Groq is a **proprietary hosted service**: the model weights are open, but requests go to Groq
under Groq's terms and data handling. Candidates see the provider label (`groq:<model>`) before
consenting, with the notice that sent requests cannot be recalled. For no third-party processing,
point `openai-compatible` at a self-hosted server. Free-tier limits change; the account's limits
page is authoritative. The free tier suits development and small pilots (about 25 LLM calls per
interview), not concurrent production load.

## Data minimisation and prompt injection

- Resume text: contact details removed at upload-read time (`redactContactDetails`), then names
  (the account display name), credentials, government ids and labelled personal fields
  (`redactForAi`), bounded to 12,000 characters. Answers and code go through `redactForAi`
  before every call. This is best-effort, not anonymisation.
- No user ids, emails, account data or the brief's confidential problem/solution are sent.
- The system message is fixed text; all candidate content travels as one JSON document under
  `data` (JSON escaping prevents breaking out of it) with instructions to treat it as data.
- Outputs are validated strictly; evidence quotes must be verbatim substrings of what was sent;
  the server enforces the interview policy, so an injected instruction cannot change a score or
  skip a rule. Text that looks like an injection attempt is flagged in the report for human
  review (`looksLikePromptInjection`, heuristic).
- Logs carry capability, provider, model, prompt version, latency, attempts, token counts and
  error codes only — never prompts, resume text, transcripts or code.

## Adding a provider

1. Implement `CapabilityAdapter`s (or reuse `openai-compatible`), register a factory.
2. Record licence, hosting terms and limits in this file.
3. Add tests against a local HTTP stub (see `test/ai/openai-compatible.test.ts`).
4. Calibrate on human-reviewed interviews before trusting scores.
