# Phase 01 — Project foundation

Date: 17 October 2026 · Contract: Implementation Contract v3.0

## What was implemented

**Monorepo and tooling.** npm workspaces (`apps/web`, `apps/server`, `packages/shared`), strict
TypeScript, ESLint (typescript-eslint, react-hooks, jsx-a11y strict), Prettier, `.env.example`,
one-command `npm run verify`, and a cross-platform ZIP packager.

**Shared contract package.** Contract constants (role key, skill IDs and the fixed alias list,
industry and mission tags, version IDs, limits), the API envelope types, every stable error code
with its HTTP status, NFKC text normalisation, and the Section 23 HTTPS URL checker.

**Backend foundations (Sections 17, 22, 23, 25).**

- `/api/v1` router with `GET /health` returning `{data: {status: "ok"}, requestId}`.
- Server-generated `requestId` on every response (client values ignored) and `X-Request-Id`.
- Standard error envelope; unexpected errors become `500 INTERNAL_ERROR` with no internals.
- Zod route validation (`withValidation`): unknown fields rejected, `422 VALIDATION_FAILED` with
  per-field messages.
- JSON-only bodies, 128 KiB limit (`413 BODY_TOO_LARGE`), multipart rejected.
- Exact-`Origin` guard on every mutation (`403 CSRF_INVALID`); the CSRF token joins it with
  sessions in Phase 2.
- General rate limit 120/min (health exempt) with `429 RATE_LIMITED` and `Retry-After`.
- Strict CSP (self only, no unsafe-eval/inline), HSTS in production, no-referrer, `no-store` on API.
- Pino JSON logging; paths without query strings; cookies, CSRF, passwords and keys redacted.
- Validated configuration: startup fails on missing values, non-HTTPS production origin, enabled
  LLM without model/key, mock providers in production, or an unknown provider label.
- MongoDB: dedicated connection, real transaction probe, versioned idempotent migrations
  (`npm run db:migrate`), production refuses to start without transactions or with pending
  migrations, loopback-only readiness probe on a separate port.
- Same-origin SPA hosting with immutable hashed assets and an SPA fallback that never touches `/api`.

**AI-provider architecture (no model calls).** Six capability ports (question generation, technical
evaluation, language evaluation, speech analysis, video signals, cross-validation), a registry that
defaults every capability to `disabled`, one `invokeCapability` call path enforcing consent,
timeouts, cancellation, strict validation and metadata-only logging, and a hardened JSON-over-HTTPS
transport for the AI team's services. Video signals are limited by type to observable events. See
[AI_PROVIDER_ARCHITECTURE.md](../architecture/AI_PROVIDER_ARCHITECTURE.md).

**Frontend.** Design tokens for light and dark themes (system, light or dark, persisted when storage
allows), Schibsted Grotesk self-hosted, reusable components (Button, ButtonLink, Badge, Card, Alert,
Text/TextArea/Select/Checkbox fields, Switch, Tabs, Spinner, Loading/Empty/Error/QueryState), landing
page with the score breakdown of the seeded "Dev" fixture (computed from its factors, 73.39),
founder / candidate / moderator layouts with responsive navigation, honest "not available yet"
states for later screens, a design-system reference page, a typed API client and TanStack Query.

## How it works

The browser only calls relative `/api/v1` URLs. In development Vite (5173) proxies `/api` to Express
(5000); in production Express serves the built SPA and the API from one HTTPS origin. Requests pass
through: request ID → logger → security headers → `no-store` → rate limit → origin guard → JSON
guard → body parser → router → 404 → error handler.

## Important files

| Area   | Files                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared | `packages/shared/src/{constants,api,text,url}.ts`                                                                                           |
| Server | `apps/server/src/http/app.ts`, `http/middleware/*`, `http/validation.ts`, `config/env.ts`, `db/{mongo,migrations,readiness}.ts`, `index.ts` |
| AI     | `apps/server/src/ai/{types,registry,invoke}.ts`, `ai/transport/http-json.ts`                                                                |
| Web    | `apps/web/src/styles/index.css`, `components/ui/*`, `components/layout/*`, `features/*`, `lib/api/*`, `lib/theme.tsx`                       |
| Docs   | `README.md`, `docs/api/openapi.yaml`, `docs/architecture/AI_PROVIDER_ARCHITECTURE.md`                                                       |

## How to run and test

```bash
npm install
cp .env.example .env
npm run db:migrate        # needs a MongoDB replica set, see README
npm run dev               # http://localhost:5173
npm run verify            # format, lint, typecheck, tests, build
```

## Test results (executed 17 Oct 2026)

`npm run verify` — exit code 0: Prettier clean, ESLint 0 warnings, TypeScript clean in all three
packages, production build succeeded.

| Package             |  Files |   Tests | Result   |
| ------------------- | -----: | ------: | -------- |
| `@cofoundry/shared` |      1 |      21 | pass     |
| `@cofoundry/server` |      7 |      71 | pass     |
| `@cofoundry/web`    |      3 |      33 | pass     |
| **Total**           | **11** | **125** | **pass** |

The delivered ZIP was also extracted into an empty folder: `npm ci` and `npm run verify` passed
there with the same 125 tests.

Also run against the built server: health envelope and CSP headers, SPA fallback, origin rejection,
readiness probe, `db:migrate`, and the three startup refusal paths (production without transactions,
missing env values, unknown LLM provider). A headless Chromium pass over 7 pages (desktop, mobile,
dark) found no console errors, no CSP violations and no horizontal overflow at 390 px.

**Environment caveat — read this.** The build sandbox could not download a MongoDB binary or image,
so database tests ran against FerretDB 1.24 (MongoDB-wire-compatible, no transactions) with
`MONGODB_TEST_EXPECT_TRANSACTIONS=false`; they passed and correctly reported `not_ready`. On your
machines `npm test` uses an in-memory MongoDB **replica set**, where the same tests expect
transactions and `ready`. That path has not been executed yet — please run `npm test` once and
report the result.

## Remaining issues

1. Real-MongoDB transaction path unverified here (see caveat).
2. No sessions yet, so mutations are protected by the Origin check only; CSRF tokens, per-session
   rate limits and auth route limits arrive with identity (Phase 2).
3. No browser E2E suite in the repo yet; the contract's deployed smoke test comes with deployment.
4. ESLint stays on v9 (end of support) because `eslint-plugin-jsx-a11y` does not yet support v10.
5. AI capability input shapes are drafts pending the updated AI interview contract.

## Assigned developers and suggested commits

Commit in this order so every commit builds on the previous one. Dev 2 has no Phase 1 files.

**1. Dev 1 (AI)** — the AI module depends on nothing else in the server.

```powershell
git add apps/server/src/ai apps/server/test/ai docs/architecture/AI_PROVIDER_ARCHITECTURE.md
git commit -m "feat(ai): add provider registry, capability ports and safe invoke path"
```

**2. Dev 3 (Backend)** — tooling, shared package, server, API docs, project docs.

```powershell
git add package.json package-lock.json tsconfig.base.json eslint.config.js .prettierrc.json .prettierignore .gitignore .gitattributes .editorconfig .nvmrc .env.example scripts packages/shared apps/server/package.json apps/server/tsconfig.json apps/server/tsup.config.ts apps/server/vitest.config.ts apps/server/src/index.ts apps/server/src/config apps/server/src/lib apps/server/src/http apps/server/src/db apps/server/test/helpers.ts apps/server/test/app.test.ts apps/server/test/config.test.ts apps/server/test/logger.test.ts apps/server/test/static-web.test.ts apps/server/test/db.integration.test.ts docs/api README.md docs/phases/PHASE_01_README.md
git commit -m "feat(server): add API foundations, MongoDB, migrations and monorepo tooling"
```

**3. Dev 4 (UI/UX)**

```powershell
git add apps/web
git commit -m "feat(web): add design system, landing page and role workspace layouts"
```

Before pushing, run `git status` — it should show nothing left to stage — then one person pushes.
