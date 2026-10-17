# Phase 03 — Candidate & founder profiles

Date: 17 October 2026. Contract: Implementation Contract v3.0, Sections 03, 06, 14, 17, 18, 22, 26.

## What was built

**Profile API (Section 18)** — all routes need a signed-in session (deny-by-default from Phase 2).

| Route                    | Behaviour                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /candidate/profile` | Candidate role (else 403). Own profile; a never-saved profile is returned blank with `revision: 0`.                                                            |
| `PUT /candidate/profile` | Full replacement with `expectedRevision` (0 = create). Stale revision → 409 `VERSION_CONFLICT`. Strict body: unknown fields → 422.                             |
| `GET /founder/profile`   | Founder role. Own profile (`bio`, `companyUrl` — the only founder fields in the contract).                                                                     |
| `PUT /founder/profile`   | Same revision rules. `companyUrl` must be HTTPS or `null`.                                                                                                     |
| `GET /profiles/:userId`  | `ProfilePublic` projection. Own profile, or an active candidate in the same cohort who is discoverable with active consent. Everything else is 404, never 403. |

**Candidate profile fields** (limits in `packages/shared/src/profile.ts`, enforced by Zod on the
server and mirrored in the editor): headline ≤160, bio ≤1000; up to 12 skills from the contract
skill list, each with level 1–5 (Beginner … Expert); 0–5 industry and 0–5 mission tags; hours
per week 1–40; commitment 1–12 months; opportunity type `contributor` (the only one in v3.0); up
to 5 projects with title 1–100, description 50–1500, 1–8 skill tags and an optional HTTPS link.
Text is NFKC-normalised and trimmed. Skill aliases (`node`, `ts`, `rest`, `mongo` …) resolve to
skill ids; other values are rejected with the allowed choices.

**Discovery and consent (Sections 03, 06, 14).** A draft can be saved incomplete while hidden.
Turning discovery on requires every non-project field plus explicit consent to the disclosure
notice; the API returns one field error per gap and the editor lists the same gaps. Consent is a
versioned record in `consent_records` (`profile-disclosure-v3.0`, granted/withdrawn timestamps).
Unticking consent turns discovery off and withdraws the record; the profile disappears from
founders on the next request (E2E-tested).

**Privacy.** `ProfilePublic` never contains email, revision, consent state, account status or
role data. Hidden, other-cohort, suspended, founder and unknown or malformed ids all answer the
same 404 so existence is not revealed. A founder profile is visible only to its owner until a
later phase defines when candidates see it. Project links are shown as "Link added, not verified"
and open only after an explicit notice (`rel="noopener noreferrer"`).

**Database.** Migration 3 (`profiles-and-consent`): unique `userId` on `candidate_profiles` and
`founder_profiles`; on `consent_records` a unique sparse `activeKey` (one active consent per
user/purpose/target) and `userId_purpose`. Projects are embedded in the candidate profile with
server-generated ids. `npm run db:seed` now creates the Section 26 demo profiles (Asha, Dev, Isha
without projects, Kabir at 6 h/week, Mira with REST level 2, Nila with 2 months, Hidden not
discoverable) and the PayPilot founder profile; `--reset` also removes profiles and consents.

**Frontend.** Candidate profile editor (About you, Skills with level scale, Availability,
Interests, Projects, Discovery and consent, live Preview of what founders see), founder profile
page, profile status card on the workspace overview, sticky save bar with unsaved-changes state,
inline and server-side field errors, conflict message with reload, light/dark and mobile layouts.
New design-system parts: `ChipGroup`, `SegmentedChoice`, `ExternalLink`.

## Implementation notes and decisions

- **No resume support.** v3.0 defines no resume field, upload or parsing, so none was added;
  projects with optional links are the contract's evidence model.
- **Ordered writes instead of a transaction.** Profile and consent are separate documents. The
  service writes them in an order that keeps "discoverable ⇒ active consent" true after every
  single write: consent is granted _before_ a discoverable profile is saved, and withdrawn only
  _after_ the save (which the validator forces to discovery off). A crash in between can leave an
  extra active consent on a hidden profile, never a visible profile without consent; retrying the
  request completes it. Reads additionally treat a profile as hidden unless an active consent
  exists. This is tested with an injected failure between the writes.
- **`activeKey` instead of a partial index.** "One active consent" is enforced by a unique sparse
  index on a storage-internal `activeKey` field that is removed on withdrawal. This works on every
  MongoDB version and on FerretDB, which has no partial indexes.
- **Optimistic concurrency.** The update is a single conditional write on `{userId, revision}`
  (a create is an insert guarded by the unique `userId` index), so of two tabs saving the same
  revision only one can succeed; the other gets 409 and is asked to reload.
- **Derived evidence status.** `evidenceStatus` is `project_linked` iff a syntactically valid
  HTTPS link is present — it never means the link was fetched or verified.
- **Deferred, not invented:** blocks and "established participant" access (they need requests
  and matches), founder fields shown to candidates (computed by later phases), any AI use of
  profile data.
- **Policy label.** `profile-disclosure-v3.0` is our identifier for the disclosure text shown in
  the editor; change it whenever that text changes so new consent is recorded.

## Important files

| Area     | Files                                                                                                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared   | `packages/shared/src/profile.ts` (limits, types, discovery rules, labels)                                                                                                  |
| Server   | `apps/server/src/profiles/{models,store,service}.ts`, `http/routes/profiles.ts`, `http/routes/{v1,auth}.ts`, `http/app.ts`, `index.ts`                                     |
| Data     | `apps/server/src/db/{migrations,seed,seed-cli,demo-accounts}.ts`                                                                                                           |
| Web      | `apps/web/src/features/profile/*`, `components/ui/{ChipGroup,SegmentedChoice,ExternalLink}.tsx`, `features/workspace/*`, `app/routes.tsx`, `lib/auth.tsx`                  |
| Tests    | `apps/server/test/profiles{,.integration}.test.ts`, `test/support/memory-profile-store.ts`, `apps/web/src/features/profile/profile.test.tsx`, `e2e/tests/profiles.spec.ts` |
| API spec | `docs/api/openapi.yaml` (0.3.0)                                                                                                                                            |

## Run and test

```bash
npm install
cp .env.example .env
npm run db:migrate && npm run db:seed    # migration 3 + demo profiles
npm run dev                              # sign in as asha@ or founder@demo.cofoundry.test → Profile
npm run verify
npm run test:e2e
```

## Results (executed 17 Oct 2026)

| Suite                                                                                    |   Tests | Result   |
| ---------------------------------------------------------------------------------------- | ------: | -------- |
| `@cofoundry/shared`                                                                      |      24 | pass     |
| `@cofoundry/server` (11 files; 57 profile unit tests + profile and DB integration tests) |     191 | pass     |
| `@cofoundry/web` (5 files; 17 profile tests)                                             |      75 | pass     |
| Playwright E2E (desktop + mobile Chromium; 6 new profile tests)                          |      13 | pass     |
| **Total**                                                                                | **303** | **pass** |

Covered: CRUD and persistence, role restrictions (403), ownership (identity only from the
session), revision conflicts, strict validation and normalisation, project limits and server
project ids, discovery requirements, consent grant/withdraw ordering with injected failure,
public projection fields, 404 for every non-visible case, CSRF/Origin on PUT, seeding.

`npm run verify` exit 0 (Prettier clean, ESLint 0 warnings, TypeScript clean incl. `e2e/`,
production build OK). Also checked by hand on a fresh database: `db:migrate` applied 1→3,
`db:seed` created 9 accounts, 7 candidate profiles, 1 founder profile and 6 active consents (all
6 discoverable candidates; Hidden has none); a second seed reported everything unchanged.
Screens were reviewed at 1440 px (light and dark) and 390 px.

**Environment blocker — real MongoDB transactions still not verified here** (unchanged from
Phase 2). This sandbox cannot download MongoDB, so database tests and E2E ran against FerretDB
1.24 with `MONGODB_TEST_EXPECT_TRANSACTIONS=false`. Phase 3 does not depend on transactions
(ordered writes, above), but the replica-set path must still be confirmed: please run
`npm test` and `npm run test:e2e` once on a team machine (in-memory replica set by default) and
report the result.

## Remaining issues

1. Real replica-set transaction path unverified in this environment (above).
2. Blocks are not implemented yet; when they arrive, `GET /profiles/:userId` must also return 404
   across a block.
3. Rate-limit counters remain in process memory (single instance per contract).
4. ESLint remains on v9 (`eslint-plugin-jsx-a11y` does not support v10 yet).

## Assigned developers and suggested commits

Commit in this order so every commit builds and the E2E tests land with the UI they drive.
Dev 1 and Dev 2 have no Phase 3 changes (no AI work in this phase).

**1. Dev 3 (Backend)** — shared contract, profile models, service, routes, migration, seeding, tests.

```powershell
git add packages/shared/src/profile.ts packages/shared/src/index.ts packages/shared/test/shared.test.ts apps/server/src/profiles apps/server/src/http/routes/profiles.ts apps/server/src/http/routes/v1.ts apps/server/src/http/routes/auth.ts apps/server/src/http/app.ts apps/server/src/index.ts apps/server/src/db apps/server/test/profiles.test.ts apps/server/test/profiles.integration.test.ts apps/server/test/db.integration.test.ts apps/server/test/support
git commit -m "feat(profiles): add candidate and founder profiles, discovery consent and public projection API"
```

**2. Dev 4 (UI/UX)** — profile editor, founder profile, preview, new UI components.

```powershell
git add apps/web
git commit -m "feat(web): add candidate and founder profile pages with live preview"
```

**3. Dev 3 (Backend)** — E2E tests, API spec and docs.

```powershell
git add e2e docs/api/openapi.yaml docs/phases/PHASE_03_README.md README.md
git commit -m "test(e2e): cover profiles, consent and privacy; docs for phase 3"
```

Run `git status` afterwards — nothing should remain unstaged.

**Cleanup from Phase 2:** the Phase 2 ZIP accidentally contained `packages/shared/state.json`, a
local state file written by the test database tool (not project code). It is removed in this
ZIP. If it was committed in Phase 2, Dev 3 removes it with the first commit:

```powershell
git rm --cached packages/shared/state.json
Remove-Item packages/shared/state.json -ErrorAction SilentlyContinue
```
