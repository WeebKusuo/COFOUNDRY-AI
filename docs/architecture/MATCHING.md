# Matching and recommendations (match-v3.0)

Deterministic, explainable ranking of candidates for a founder's open brief (Contract Sections
04–06, 15, 19, 23–25). No AI, embeddings or probabilistic ranking.

```
POST /startups/:id/recommendations
  │ owner + open brief + Idempotency-Key + 10/min
  ▼
RecommendationService.generate
  │ pool: 4 bulk queries ─ active candidate ids in cohort → users → discoverable profiles
  │                        (≤ 1,000, else 503) + active discovery consents; minus founder, blocks
  ▼
matching/engine.ts  matchCandidates(brief, pool)        ← pure: no I/O, clock or randomness
  │ prepareBrief → gates → S, A, I, P → score → group → top 3 ≥ 50 → reasons
  ▼
recommendation_batches  (computed entries + profileRevision only; expires +15 min; entries purged at 24 h)

GET /startups/:id/recommendations
  │ latest batch → expired / brief closed or changed → 409
  │ re-check visibility of every entry (3 bulk queries) → withhold the invisible (no refill)
  │ any remaining profileRevision changed → 409 STALE_RECOMMENDATION
  ▼
response: entries + ProfilePublic-style projection rebuilt from the current (unchanged) profile
```

| Module                                   | Responsibility                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `packages/shared/src/matching.ts`        | Types, weights, thresholds, gate codes, display rounding                 |
| `apps/server/src/matching/engine.ts`     | The algorithm; validated brief (`MatchBriefError`), pure output          |
| `apps/server/src/recommendations/*`      | Pool loading, batches, freshness, privacy re-checks, invitation boundary |
| `apps/server/src/safety/blocks.ts`       | `BlockPolicy` port; `NO_BLOCKS_YET` until the Safety phase               |
| `apps/web/src/features/recommendations/` | Dashboard; displays server results only                                  |

**Invariants.** Scores are computed only on the server and never accepted from clients. The
same pool always yields the same output (sorted by unrounded score, then candidate id). Groups
are mutually exclusive. Stored batches contain no profile text, contact data, resume data or
brief content. A batch is never "repaired" after a revision change; a fresh search is required.

**Invitation boundary.** `RecommendationService.resolveForInvitation` is the check the interview
phase must call before creating an invitation: unexpired batch of the founder's open brief, a
listed and still-visible candidate, unchanged profile revision and re-passed hard gates;
otherwise 409 `STALE_RECOMMENDATION`.
