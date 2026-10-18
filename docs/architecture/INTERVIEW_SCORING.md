# Interview scoring — `rubric-interview-v1`

Source of truth: `packages/shared/src/rubric.ts` (weights, level anchors, aggregation and
calibration fixtures). Tests (`packages/shared/test/interview.test.ts`) assert the aggregation
reproduces every fixture exactly before any report uses it. Changing a weight requires a new
rubric version and new fixtures; reports store the version they were computed with.

**These weights are a documented initial configuration chosen for transparency (correctness
first, then reasoning), not an empirically validated model.** Calibrate them against
human-reviewed interviews before relying on them. Reports support human review and never accept
or reject a candidate.

## Technical answers

Each answer is judged by the evaluator model on six dimensions, levels 0–4 with written anchors.
Every non-null level must quote the answer verbatim, and the quote must be substantial (≥ 12
characters, or ≥ 3 words and ≥ 8 characters, or the whole answer); levels whose quotes are not
found are discarded as **insufficient evidence** (null) — missing evidence is never treated as
wrong. An answer whose correctness level is discarded is reported as **not assessed**.

| Dimension               | Weight |
| ----------------------- | -----: |
| Correctness             |   0.30 |
| Reasoning quality       |   0.20 |
| Practical understanding |   0.15 |
| Specificity & depth     |   0.15 |
| Relevance               |   0.10 |
| Consistency             |   0.10 |

- Answer score = 25 × Σ(weight × level) / Σ(weight) over non-null dimensions (0–100).
- Correctness null → the answer is excluded ("not assessed"). Skipped or timed-out questions
  score 0. Evaluation failures never produce a score.
- Technical score = mean answer score. Coverage = scored answers / max(asked, 6).

## Coding

| Part                              | Weight | Source                                                 |
| --------------------------------- | -----: | ------------------------------------------------------ |
| Functional tests (visible+hidden) |   0.60 | deterministic, Judge0                                  |
| Performance check                 |   0.15 | large input within a CPU limit (when the task has one) |
| Code review (AI)                  |   0.25 | readability, approach, edge cases (0–4, quoted code)   |

Weights are re-normalised over the available parts. **Without executed tests there is no coding
score** — an AI review alone never scores code. A compile error scores 0 on tests and
performance. No submission, or blank code, scores 0. A sandbox fault (Judge0 internal error or
outage) is never counted as failed tests: the evaluation retries, and if the fault persists to
the last attempt the execution is recorded as `failed` with no coding score.

## Overall technical assessment

0.60 × technical + 0.40 × coding (re-normalised when one part is missing). Bands: ≥ 75 strong,
≥ 50 mixed, otherwise limited; coverage below 60 % → "insufficient evidence" regardless of the
number. **Communication is reported on its own scale (clarity 0.25, technical explanation 0.25,
structure 0.20, reasoning communication 0.20, grammar 0.10, lenient) and never enters any
technical or coding number.** Accent, fluency and transcription errors are not penalised; low
transcript confidence and candidate edits are shown next to the answer.

## Calibration fixtures (excerpt)

| Case                                    |     Expected |
| --------------------------------------- | -----------: |
| all levels 4                            |          100 |
| levels 3,4,2,3,1,4                      |         67.5 |
| correctness 4, reasoning 4, others null |          100 |
| correctness null                        |     excluded |
| coding 8/10 tests, perf 1/1, review 3s  |        81.75 |
| execution unavailable, review 4s        |     no score |
| technical 70, coding 90, coverage 1     |    78 strong |
| technical 90, coding 90, coverage 0.5   | insufficient |

Aggregation uses integer micro-unit weights so results never drift in floating point.
