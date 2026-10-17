# Phase 06 — Recommendation batches and founder dashboard

Date: 17 October 2026. Contract: Implementation Contract v3.0, Sections 06, 15, 17, 19, 23–25,
27 (MAT-07, MAT-08). Built on the Phase 5 engine ([PHASE_05_README](PHASE_05_README.md)).
Architecture overview: [docs/architecture/MATCHING.md](../architecture/MATCHING.md).

## Endpoints

| Route                                | Behaviour                                                                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /startups/:id/recommendations` | Founder owner, `{}` body, Idempotency-Key, 10/min per founder. Open brief only (else 409 `INVALID_STATE`). Computes with match-v3.0 and stores a batch; 201 search response. |
| `GET /startups/:id/recommendations`  | Latest valid batch with privacy re-check; 409 `STALE_RECOMMENDATION` when none, expired, brief closed/changed or any listed profile revision changed.                        |

Other founders get 404, non-founders 403, malformed ids 404. Response (Section 17):
`{batchId, briefId, briefVersion, generatedAt, expiresAt, algorithmVersion, recommendations[],
provisional[], nearMatches[], exclusions:{totalExcluded, gates[]}}`.
Each entry has the Phase 5 explanation fields plus a `profile` with ProfilePublic candidate fields
and the display name only — no email, consent, account, resume or brief-confidential data.

## Batches (`recommendation_batches`, migration 6)

`briefId, briefVersion, founderUserId, algorithmVersion, generatedAt, expiresAt (+15 min),
totalExcluded, gateCounts[], entries[], entriesPurgedAt`; indexes `briefId+generatedAt` and
`generatedAt`. Entries hold computed results and each candidate's `profileRevision` — never
profile text. The sweeper removes entry contents after 24 hours (Section 24); a purged batch is
stale. `--reset` seeding removes demo founders' batches.

**Freshness and invalidation.** A read rejects the batch (409) when it expired, its entries were
purged, the brief is no longer the open version that was searched, or — after privacy filtering —
any listed candidate's profile revision changed (Section 06: filter first, then compare). A
candidate who turned discovery off, withdrew consent, was suspended, left the cohort or became
blocked is withheld silently: the response carries no count or marker of withheld candidates,
and the list is not refilled. Consent and discovery changes therefore take effect on the very next
read; a fresh search is required to re-rank.

**Concurrency and failures.** The same Idempotency-Key returns the same batch (also for
simultaneous requests); different keys create separate batches and the latest is served. Batch
ids are reserved before computing, so a crash and retry never duplicates. Search computation is
read-only until the single insert; a failure stores nothing.

**Efficiency.** A search uses four bulk queries (cohort candidate ids, users, active discovery
consents, then the consenting users' discoverable profiles capped at 1,001) — no per-candidate queries — and refuses more than
1,000 discoverable (discovery on **and** consenting) candidates with 503 `CAPACITY_LIMIT`
instead of sampling. A read re-checks the
at most nine listed candidates with three bulk queries. Scoring is O(candidates × required
skills) in memory.

**Invitation boundary.** `RecommendationService.resolveForInvitation(founder, {briefId, batchId,
candidateUserId})` implements MAT-08 for the interview phase: unexpired batch of the owned open
brief, listed and still-visible candidate, unchanged revision, re-passed gates; else 409. No
invitation route, record or UI action exists yet.

## Founder dashboard (`/founder/candidates`)

Brief selector (open briefs only; empty state links to Briefs), "Find candidates" / "Run a new
search", summary (algorithm version, generated time, live minutes-left countdown, group counts,
gate-only exclusion counts), and three separate sections: Recommended,
Provisional (explained), Near matches (deficits listed). Each card shows rank, name, demo label,
headline, two-decimal score, factor bars with the weights used (P "not counted" when provisional),
strengths, near-match shortfalls and remaining skill gaps. "View details" opens the skill table
(needed, team, candidate, fit, share of gap), projects with relevance, matched gap skills and
self-reported links behind the external-site notice, and interests. **Invite to interview** is
shown disabled with "Not available yet: interview invitations arrive in a later phase" (or, once
expired, "Run a new search before inviting anyone"). Loading, empty, error/retry, expired and
rate-limit states; responsive at phone, tablet and desktop widths; light and dark themes. The
client never computes scores or visibility: everything shown comes from the API.

**Independent review.** A separate review agent audited the engine and batches: the formulas,
gates, grouping, ordering, freshness, idempotency and access rules were confirmed. It found two
defects, both fixed with tests: the capacity limit counted candidates with discovery on but no
consent (now only consenting candidates count), and reads returned a count of candidates withheld
since the search, which could reveal that someone just hid their profile or blocked the founder
(removed from the API and UI; withheld candidates now disappear silently).

## Security

Server-side session, CSRF, exact Origin, RBAC (founder), brief ownership (404), cohort, consent,
discovery and account status on every search **and** every read; blocks via `BlockPolicy`;
Idempotency-Key; rate limit; strict bodies and queries; no client-supplied scores or ids are
trusted; responses tested to exclude emails, consent fields, resume file names/text and brief
problem/solution.

## Tests (executed 17 Oct 2026)

| Suite                                                                                                 |   Tests | Result   |
| ----------------------------------------------------------------------------------------------------- | ------: | -------- |
| `@cofoundry/shared`                                                                                   |      36 | pass     |
| `@cofoundry/server` (19 files; new: engine 20, recommendations API 17, recommendations integration 6) |     303 | pass     |
| `@cofoundry/web` (8 files; new: dashboard 8)                                                          |     103 | pass     |
| Playwright E2E (desktop + mobile; new: dashboard 2, mobile dashboard 1)                               |      20 | pass     |
| **Total**                                                                                             | **462** | **pass** |

Recommendation API tests cover: Section 26 groups and gate counts; stored batch contents; privacy
of the projection (including a candidate with a resume); owner/founder/idempotency/open-brief
rules; duplicate and parallel requests; blocked, suspended, other-cohort, undiscoverable and
self exclusion from results **and** counts; consent required; rate limit; capacity limit; latest
batch; 15-minute expiry boundary; revision change; withdrawn consent/discovery/block withheld
without refill; closed brief; other founders; 24-hour purge; the invitation boundary. The
integration suite repeats the Section 26 result on the seeded database, invalidation after a real
profile save, discovery-off on the next read, purge and reset. E2E runs a real search in the
browser, opens details, checks the disabled invite action, inspects the raw API response for
leaks, turns a candidate's discovery off in another session and confirms she is withheld, and
checks the phone layout.

`npm run verify` exit 0 (Prettier, ESLint 0 warnings, TypeScript incl. `e2e/`, production build).

**Blocker — real MongoDB replica-set transactions still unverified.** Re-attempted: MongoDB
downloads (`fastdl.mongodb.org`, `repo.mongodb.org`) are blocked by this environment's network
allowlist, so database tests and E2E ran on FerretDB 1.24, which has no transactions. That is not
equivalent to a successful MongoDB transaction test. Phases 5–6 use no transactions (single-insert
batches, read-only scoring). Please run `npm test` and `npm run test:e2e` once on a team machine,
where an in-memory replica set is used by default.

## Limitations

1. Blocks: no block records exist until the Safety phase (`NO_BLOCKS_YET`); the filter is in
   place and tested with a stub policy.
2. Rate-limit counters are in process memory (single instance).
3. Only the founder's newest 20 briefs feed the brief selector (first page of the owner list).
4. Gate counts (`exclusions`) are those computed at search time and are replayed unchanged for
   the batch's 15 minutes; they never name anyone, but a candidate who became private after the
   search can still be inside a number until the batch expires.
5. The recommendation entries' 24-hour purge runs in the 5-minute sweeper; until it runs, an
   expired batch is already unusable (409) but its entries still exist.

## Assigned developers and suggested commits

Dev 1 and Dev 2 have no changes: v3.0 matching is deterministic and uses no AI. Commit in order;
run `npm run verify` after the last commit.

**1. Dev 3 (Backend)** — Phase 5 engine.

```powershell
git add packages/shared/src/matching.ts packages/shared/src/index.ts apps/server/src/matching apps/server/test/matching.engine.test.ts
git commit -m "feat(matching): add deterministic match-v3.0 engine with gates, scoring and grouping"
```

**2. Dev 3 (Backend)** — Phase 6 batches, API, retention and tests.

```powershell
git add apps/server/src/recommendations apps/server/src/safety apps/server/src/http/routes/recommendations.ts apps/server/src/http/routes/v1.ts apps/server/src/http/app.ts apps/server/src/index.ts apps/server/src/auth/store.ts apps/server/src/profiles/store.ts apps/server/src/db/migrations.ts apps/server/src/db/seed.ts apps/server/test/recommendations.test.ts apps/server/test/recommendations.integration.test.ts apps/server/test/db.integration.test.ts apps/server/test/support
git commit -m "feat(recommendations): add recommendation batches, freshness and privacy re-checks"
```

**3. Dev 4 (UI/UX)** — founder recommendations dashboard.

```powershell
git add apps/web
git commit -m "feat(web): add founder candidate recommendations dashboard"
```

**4. Dev 3 (Backend)** — E2E, API spec and docs.

```powershell
git add e2e docs/api/openapi.yaml docs/architecture/MATCHING.md docs/phases/PHASE_05_README.md docs/phases/PHASE_06_README.md README.md
git commit -m "test(e2e): cover matching and recommendations; docs for phases 5 and 6"
```

Run `git status` afterwards — nothing should remain unstaged.
