# AI provider architecture

Status: Phase 4 — contracts and integration points only. No model is called anywhere yet; every
capability is registered as `disabled`. Question generation and adaptive follow-up now use the
versioned contract `ai-interview-contract-v1` (`packages/shared/src/interview.ts`).

## Goals

- Swap any model (the AI team's fine-tuned service, an external LLM, a speech API) by configuration,
  without changing business logic.
- Keep every credential on the server and log metadata only.
- Keep technical scores, language feedback and observable presentation signals **separate**.
- Make consent a precondition that code cannot skip.

## Shape

```
business code ──► invokeCapability(registry, capability, input, {timeoutMs, outputSchema, consent})
                         │  consent check (audio/video)      ─► consent_missing
                         │  timeout + outer cancellation     ─► timeout / cancelled
                         │  adapter.run(input, ctx)          ─► raw output + token usage
                         │  strict zod validation, no clamp  ─► invalid_output
                         ▼
                  ProviderResult<T> = {ok:true, value, meta} | {ok:false, error, meta}
```

| File (`apps/server/src/ai/`) | Purpose                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `types.ts`                   | Capability list, draft input types, `CapabilityAdapter`, `ProviderResult`, consent proof |
| `registry.ts`                | `AiProviderRegistry`, `PROVIDER_FACTORIES`, `createAiRegistry` (fails on unknown labels) |
| `invoke.ts`                  | The single call path: consent, timeout, cancellation, validation, metadata logging       |
| `transport/http-json.ts`     | JSON-over-HTTPS client for model services: no redirects, size cap, bearer key            |
| `adapters/disabled.ts`       | Production-safe default; every call returns `disabled`                                   |

The module depends only on `zod` and itself, so it can be tested and reviewed independently.

## Capabilities

| Capability             | Owner         | Notes                                                                                                                                                                                              |
| ---------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `question_generation`  | Dev 2         | User's fine-tuned API: resume-based technical questions from `ResumeQuestionGenerationInput` (redacted resume text, skills, required skills)                                                       |
| `follow_up_generation` | Dev 2         | User's fine-tuned API: one adaptive follow-up from one question and its one answer (`FollowUpGenerationInput`)                                                                                     |
| `technical_evaluation` | Dev 1         | Correctness, reasoning, completeness, practicality per answer; backend computes totals                                                                                                             |
| `language_evaluation`  | Dev 1         | English/Hindi detection plus grammar, clarity, communication feedback — never mixed into technical scores                                                                                          |
| `speech_analysis`      | Dev 1         | Transcription with timestamps; pace and pauses computed deterministically by the backend. Needs `interview_audio` consent                                                                          |
| `video_signals`        | Dev 1         | Observable events only (`face_visible`, `face_not_visible`, `multiple_faces`, `gaze_off_screen`, `camera_interrupted`). Never cheating, confidence or nervousness. Needs `interview_video` consent |
| `cross_validation`     | Dev 1 / Dev 2 | Validation logic supplied by the AI team                                                                                                                                                           |

## Adding a provider (checklist)

1. Create `adapters/<provider>.ts` implementing `CapabilityAdapter<C>` for the capabilities it covers.
   Use `createHttpJsonTransport` for HTTP services; never accept URLs from user input.
2. Register a factory in `PROVIDER_FACTORIES`. Read secrets from server config only.
3. Define a strict zod output schema next to the business code that consumes it.
4. Send minimum data: no user IDs, emails, phone numbers or full startup ideas. Delimit candidate
   text as data, never as instructions.
5. Record the exact model identifier and bump `adapterVersion` on any prompt/parsing change.
6. Add tests with a local HTTP stub (see `test/ai/http-json.test.ts`) and, for graders, run the
   Section 10 calibration diagnostic before claiming reliability.

## Reports (later phases)

Interview reports keep three independent sections, each with its own provenance (provider, model,
version, time) and its own dispute path:

1. Technical rubric scores (anchors only) — numeric, computed by the backend.
2. Language feedback — qualitative; does not change technical scores.
3. Observable presentation signals — event timelines with explicit limitations; no inferred traits.

## Phase 4: interview system contracts

Planned flow: founder invitation → candidate acceptance (consents) → live interview room
(candidate webcam + AI avatar) → spoken introduction → resume-based technical questions → spoken
answers → speech-to-text → adaptive follow-up → separate analyses → final report. Phase 4 builds
none of the room, avatar, speech, video or scoring; it fixes the data contracts below.

| Contract                        | Where                                                                                   | Notes                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resume metadata and status      | `shared/resume.ts` (`ResumeMetadata`, `ResumeExtraction`)                               | Version never reused; `succeeded` or `no_text`; extractor version and text SHA-256 recorded                                                          |
| Resume reference on a session   | `shared/interview.ts` (`ResumeRef`, `InterviewResumeBinding`)                           | `resume_based` with `{resumeVersion, textSha256, extractorVersion}` or `profile_only` with the reason                                                |
| Readiness check before starting | `resumeInterviewReadiness`, `resolveResumeBinding`                                      | No resume, no text or no consent → profile-only questions; never a blocked candidate                                                                 |
| Question-generation input       | `buildResumeQuestionInput` (`src/interviews/`)                                          | Redacted resume text (emails, phones, links removed), self-reported skills/projects, required skills. No ids, names, links or brief problem/solution |
| Output validation               | `src/ai/contracts.ts`                                                                   | Strict zod schemas; `checkQuestionEvidence` rejects questions whose quote is not an exact substring of the resume text                               |
| Analysis categories             | `TechnicalCorrectness`, `LanguageFeedback`, `AudioCharacteristics`, `VideoObservations` | Only technical correctness can score (`technicalScoringInputs`); the others carry `affectsTechnicalScore: false`                                     |
| Media and analysis consent      | `InterviewMediaConsent` (`interview-media-v1`)                                          | Required: webcam, microphone, technical analysis. Optional: recording, language, audio, video analysis — declining skips them, never penalises       |

Only `ResumeService.readForInterviewProcessing` releases resume content outside the candidate's
own routes, and only after re-checking consent and extraction status. No HTTP route exposes it.

**Audio and video observations are not evidence** of cheating, nervousness, confidence or
dishonesty and never change technical scores (`OBSERVATION_LIMITATIONS_NOTICE`).

## Model and tool policy

Every AI model or AI-related tool adopted in later phases must be free, open-source, reasonably
well-performing and preferably self-hostable. Before registering a provider, record its exact
model identifier, licence and whether the licence permits commercial use. The user's fine-tuned
question-generation and follow-up APIs will be supplied later and plug in as adapters for
`question_generation` and `follow_up_generation`.

The only new third-party component in Phase 4 is **pdf.js** (`pdfjs-dist` 6.3.289, Apache-2.0,
commercial use permitted), used for resume text extraction. It is not an AI model.
