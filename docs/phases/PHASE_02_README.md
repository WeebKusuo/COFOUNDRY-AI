# Phase 02 — Authentication & security

Date: 17 October 2026. Contract: Implementation Contract v3.0, Sections 14, 17, 18, 22, 23, 25, 26.

## What was built

**Identity API (Section 18)**

| Route               | Behaviour                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /auth/csrf`    | Public. Creates a 15-minute anonymous session cookie if none exists, returns a fresh CSRF token. 30/min per IP.     |
| `POST /auth/login`  | Needs the anonymous CSRF token and exact Origin. Generic 401 for every failure. Rotates the session and CSRF token. |
| `POST /auth/logout` | Revokes the session, clears the cookie, 204.                                                                        |
| `GET /me`           | Own identity only. `profileSummaries` is empty until profiles exist (Phase 3).                                      |

No sign-up, email verification or password reset exists — accounts come only from the seed
command (or the operator for a future pilot).

**Security (Section 22/23)**

- Argon2id, 64 MiB / 3 iterations / parallelism 1, random salt per hash; dummy-hash check for
  unknown emails, so timing does not reveal which accounts exist.
- Random 32-byte session token in the cookie, only its SHA-256 stored. Cookie
  `__Host-cofoundry; HttpOnly; Secure; SameSite=Lax; Path=/` in production, `cofoundry-dev`
  without `Secure` on localhost. Never in localStorage or a response body.
- 8-hour absolute and 30-minute idle expiry, checked on every request; a session also dies when
  the account is not `active` or its `authVersion` changed.
- Synchronizer CSRF token stored as a hash on the session, constant-time comparison, required on
  every mutation including login and logout, after the exact-Origin check.
- Login limits: 5 failed attempts per normalised account and 20 per IP per 15 minutes. General
  limit: 120 requests/min per session (per IP before sign-in). All answer 429 with `Retry-After`.
- Expired and idle sessions are also purged every 5 minutes by a sweeper.

**Authorization (Section 17).** Deny by default: every `/api/v1` route needs a signed-in session
unless it is one of the three public routes, so new routes are protected automatically.
`requireRole(...)` gives 403 for a role the user lacks; `assertOwnedBy()` reports another user's
resource as 404. Identity always comes from the session, never from the request.

**Database.** Migration 2 creates `users` (unique `emailLower`, unique sparse `seedKey`) and
`sessions` (unique `tokenHash`, `expiresAt`, `lastSeenAt`, `userId`). `npm run db:seed` creates 9
demo accounts (PayPilot founder, the 7 Section 26 candidates, a moderator), is idempotent by
`seedKey`, runs only with `DEMO_MODE=true`, refuses databases holding pilot accounts, and
`--reset` asks for confirmation. A changed demo password re-hashes and bumps `authVersion`.

**Frontend.** Sign-in page (generic errors, rate-limit wait time, password visibility toggle,
shared-demo-account notice), `AuthProvider` backed by `GET /me`, `RequireRole` guard on every
workspace, access-denied state for the wrong role, user name and "Demo account" banner in the
shell, sign-out, and an explicit "Your session ended" flow that returns the user to the page they
were on. The API client fetches the CSRF token lazily, resets it after sign-in/sign-out and
retries once when a token is stale (e.g. another tab rotated it).

## Implementation notes

- **Transactions.** No Phase 2 write needs one: each operation (create/delete a session, update a
  CSRF hash, seed one user) is a single-document atomic write, and a crash between the two steps
  of login rotation only leaves an anonymous 15-minute session behind. Multi-document workflows
  that require transactions start with Phase 3+ (requests, matches, sprints). Production startup
  still refuses to run without transaction support.
- **No TTL index.** Session expiry is enforced on every request; the cleanup is an explicit sweeper
  so idle and absolute expiry are purged by the same rule.
- **Bug fixed during the phase:** after sign-in, navigating directly from the form raced the
  session state and briefly bounced through the route guard; redirects are now driven by session
  state only (found by a component test).

## Important files

| Area      | Files                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Auth core | `apps/server/src/auth/{crypto,models,store,service,cookies}.ts`                                                                  |
| HTTP      | `apps/server/src/http/middleware/auth.ts`, `http/routes/{auth,v1}.ts`, `middleware/rate-limit.ts`, `http/app.ts`                 |
| Data      | `apps/server/src/db/{migrations,seed,seed-cli,demo-accounts}.ts`                                                                 |
| Shared    | `packages/shared/src/auth.ts`                                                                                                    |
| Web       | `apps/web/src/lib/auth.tsx`, `lib/api/client.ts`, `features/auth/{SignInPage,RequireRole}.tsx`, `components/layout/AppShell.tsx` |
| E2E       | `e2e/playwright.config.ts`, `e2e/start-server.ts`, `e2e/tests/*.spec.ts`                                                         |

## Run and test

```bash
npm install
cp .env.example .env
npm run db:migrate && npm run db:seed
npm run dev                # sign in at http://localhost:5173/sign-in
npm run verify             # format, lint, typecheck, unit + integration tests, build
npm run e2e:install        # once
npm run test:e2e           # Playwright, real server + in-memory MongoDB replica set
```

## Results (executed 17 Oct 2026)

| Suite                                                                                            |   Tests | Result   |
| ------------------------------------------------------------------------------------------------ | ------: | -------- |
| `@cofoundry/shared`                                                                              |      22 | pass     |
| `@cofoundry/server` (9 files: auth, app, config, logger, static, AI ×2, DB and auth integration) |     123 | pass     |
| `@cofoundry/web` (4 files)                                                                       |      58 | pass     |
| Playwright E2E (desktop + mobile Chromium)                                                       |       7 | pass     |
| **Total**                                                                                        | **210** | **pass** |

`npm run verify` exit 0 (Prettier clean, ESLint 0 warnings, TypeScript clean incl. `e2e/`,
production build OK). Also checked by hand: `db:migrate`, `db:seed` twice (9 created, then 9
unchanged), sign-in through the Vite dev proxy, built-server refusals (production without
transactions, production seed without password, seed with `DEMO_MODE=false`).

**Environment blocker — real MongoDB transactions not verified here.** This sandbox cannot download
a MongoDB binary or image (MongoDB, Docker Hub, conda and PPA mirrors are blocked; Ubuntu's archive
only has 3.6, which has no transactions). Database tests and E2E therefore ran against FerretDB
1.24 (MongoDB wire protocol, no transactions) with `MONGODB_TEST_EXPECT_TRANSACTIONS=false`. On your
machines the same commands use an in-memory **replica set**; the transaction and readiness tests
then expect `supported`/`ready`. Please run `npm test` and `npm run test:e2e` once and report the
result.

## Remaining issues

1. Real replica-set transaction path unverified in this environment (above).
2. Rate-limit counters are in process memory — correct for the contract's single instance, but a
   shared store is needed before running more than one server instance.
3. The browser logs a console error for each expected 401 (signed-out `/me`, wrong password);
   the API contract requires these status codes.
4. ESLint remains on v9 (`eslint-plugin-jsx-a11y` does not support v10 yet).

## Assigned developers and suggested commits

Commit in this order. Dev 1 and Dev 2 have no Phase 2 changes (no AI work in this phase).

**1. Dev 3 (Backend)** — auth, sessions, RBAC, database, seeding, shared types, E2E, tooling, docs.

```powershell
git add .env.example .gitignore eslint.config.js package.json package-lock.json scripts/package-zip.mjs packages/shared apps/server/package.json apps/server/tsup.config.ts apps/server/src/auth apps/server/src/db apps/server/src/http apps/server/src/index.ts apps/server/test/app.test.ts apps/server/test/auth.test.ts apps/server/test/auth.integration.test.ts apps/server/test/db.integration.test.ts apps/server/test/static-web.test.ts apps/server/test/support e2e docs/api/openapi.yaml docs/phases/PHASE_02_README.md README.md
git commit -m "feat(auth): add sessions, CSRF, Argon2id login, RBAC, seeding and E2E tests"
```

**2. Dev 4 (UI/UX)** — sign-in page, session handling, protected workspaces.

```powershell
git add apps/web
git commit -m "feat(web): add sign-in, session handling and role-protected workspaces"
```

Run `git status` afterwards — nothing should remain unstaged. `npm run test:e2e` passes once both
commits are in (the E2E tests drive the new UI).
