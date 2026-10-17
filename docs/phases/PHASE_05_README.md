# Phase 05 — Deterministic matching engine (match-v3.0)

Date: 17 October 2026. Contract: Implementation Contract v3.0, Sections 03, 04, 05, 26, 27
(MAT-01…MAT-07). Delivered together with Phase 6; see [PHASE_06_README](PHASE_06_README.md).

## What was built

`apps/server/src/matching/engine.ts` — a pure TypeScript module (no I/O, clock, randomness or AI)
with `prepareBrief`, `failedGates`, `evaluateCandidate` and `matchCandidates`; shared types and
constants in `packages/shared/src/matching.ts`. Version label `match-v3.0`.

### Eligibility (applied before scoring)

The engine receives an already privacy-filtered pool (Phase 6 loads it): active users with the
candidate role in the founder's cohort, discovery on **and** an active profile-discovery consent,
never the founder, blocked relationships removed. It then applies the four business gates; each
failed gate counts once per candidate, `totalExcluded` is separate, and no identities are reported:

| Gate                 | Fails when                                                     |
| -------------------- | -------------------------------------------------------------- |
| `opportunity_type`   | the candidate is not open to contributor roles                 |
| `essential_skill`    | any mandatory required skill: candidate level < required level |
| `minimum_hours`      | `mandatoryAvailability` and hours < required                   |
| `minimum_commitment` | `mandatoryCommitment` and months < required                    |

There are no location, language, gender, age or other gates in v3.0; work mode is fixed remote.

### Exact formula (full precision until display)

```
gap[s] = max(0, requiredLevel[s] - teamLevel[s])        missing team skill = 0
fit[s] = min(1, candidateLevel[s] / requiredLevel[s])   missing candidate skill = 0
S = 100 · Σ importance·gap·fit / Σ importance·gap        Σ importance·gap = 0 → NO_SKILL_GAP
H = min(1, hours/requiredHours);  D = min(1, months/requiredMonths);  A = 100 · (0.6H + 0.4D)
I = 100 · (0.5 · industryOverlap/briefIndustries + 0.5 · missionOverlap/briefMissions)
P[p] = 100 · Σ importance·gap (gap skills tagged on p) / Σ importance·gap;  P = max P[p]
score = 0.40S + 0.25A + 0.15I + 0.20P                    with projects (coverage 1, even if P=0)
score = (0.40S + 0.25A + 0.15I) / 0.80                   no projects: P=null, provisional, coverage 0.80
```

Surplus time earns nothing; extra projects never inflate P (best single project, ties keep the
first listed); descriptions and URLs do not affect P. Invalid briefs (duplicate skills, level 0,
importance outside 1–5 or fractional, no gap, missing time or interests) raise `MatchBriefError`
— never NaN or Infinity.

### Classification

Mutually exclusive groups, precedence near-match → provisional → complete:

- **nearMatches** — gate-passing but below a non-mandatory hours or months target
  (`nearMatchDeficits` lists each; the provisional badge is kept when projects are missing);
- **provisional** — no projects supplied;
- **recommendations** — everyone else.

Each group: unrounded score ≥ 50, sorted by score descending then `candidateUserId` ascending,
top three, never padded. Display uses two decimals only (`formatMatchScore`).

### Explanations

Every entry carries components, the weights actually applied (`0.5/0.3125/0.1875` when
provisional), coverage, per-skill detail (required, team, gap, candidate level, fit, share of the
gap), per-project relevance with the matched gap skills, the best project, and deterministic
reason templates: at most three highest positive contributions plus every near-match deficit.

## Tests (executed 17 Oct 2026)

`apps/server/test/matching.engine.test.ts` — 20 tests, no database:

- **MAT-01:** the Section 26 PayPilot fixture (Asha 100; Dev S 71.428571, I 75, P 42.857143,
  score 73.392857 → 73.39; Isha provisional 100 at coverage 0.80; Nila near-match A 86.666667,
  score 96.666667 → 96.67; Kabir `minimum_hours`, Mira `essential_skill`; gate counts).
- **MAT-02:** surplus time (A = 100); 6/8 hours gives A = 85, a near-match when optional and
  excluded when mandatory.
- **MAT-03:** missing projects → provisional 0.80; an irrelevant project gives P = 0 and stays
  complete; 64 versus 80; groups never merge.
- **MAT-04/05:** each invalid brief case, every gate counted once, no NaN or Infinity.
- **MAT-06:** equal scores sorted by id; a raw score below 50 is omitted even when it would
  display as 50.00; fewer than three stays fewer.
- Also: the Section 05 numbers 89.25 and 91.5625 and the 7/5 denominator example; unlisted skill
  is level 0; gap-0 skills ignored; best-project rule; output independent of pool order.

The same groups and scores are asserted again end-to-end on the seeded database
(`recommendations.integration.test.ts`) and through the HTTP API (`recommendations.test.ts`).

## Limitations

- Blocks: the pool removes blocked pairs through `BlockPolicy`, but block records arrive with the
  Safety phase, so no block can exist yet (`NO_BLOCKS_YET`; tests use a stub policy).
- Scores rank self-reported data; they are not probabilities and tags are not verified.
