# AI provider architecture

Status: Phase 1 — architecture only. No model is called anywhere yet. The updated AI interview
contract will supersede the draft input/output shapes before the interview phases.

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
| `question_generation`  | Dev 2         | Fine-tuned model API: next question / follow-up from profile summary and history                                                                                                                   |
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
