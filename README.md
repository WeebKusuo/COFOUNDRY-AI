# CoFoundry AI

Find the people your startup is missing. Test the fit. Build together.

CoFoundry AI helps a founder find a backend contributor, assess fit with a transparent interview
and agree a bounded trial sprint. The engineering source of truth is
**Implementation Contract v3.0** (PDF shared with the team, not stored in this repository).

## Project status

| Phase | Scope                                                                                                                 | Status                                                                      |
| ----- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 01    | Foundation: monorepo, design system, landing, role layouts, API foundations, MongoDB, AI-provider architecture, tests | Done — see [docs/phases/PHASE_01_README.md](docs/phases/PHASE_01_README.md) |
| 02–18 | Identity, profiles, briefs, matching, interviews, requests, sprints, safety, privacy, deployment                      | Not started                                                                 |

What exists today versus what is deferred:

- **Implemented:** `GET /api/v1/health`, standard envelopes and error codes, validation, origin
  guard, rate limiting, strict CSP, logging with redaction, MongoDB connection, migrations,
  internal readiness probe, same-origin SPA hosting, design system, landing page, founder /
  candidate / moderator layouts, AI-provider registry (all providers `disabled`).
- **Not yet implemented:** sign-in and sessions (so no CSRF token yet), every product feature
  route, seed command, worker jobs. Workspace pages are labelled previews and store nothing.
- **Off-platform by contract:** live walkthroughs and payments.

## Stack

TypeScript monorepo (npm workspaces) · React 19, Vite 8, Tailwind CSS 4, React Router 7,
TanStack Query 5 · Express 5, Mongoose 9, Zod 4, Pino · Vitest, Testing Library, Supertest.

```
apps/web         React SPA (design system, landing, workspace layouts)
apps/server      Express API, MongoDB, migrations, AI-provider architecture
packages/shared  Contract constants, API envelope types, pure helpers (used by both)
docs/            Phase reports, OpenAPI spec, architecture notes
scripts/         Packaging script (ZIP per phase)
```

## Requirements

- Node.js **22.12 or newer** (`node -v`) and npm 10+
- MongoDB **as a replica set** (transactions are required; production refuses to start without
  them). For tests nothing is needed: the suite starts an in-memory replica set automatically.

## Setup

```bash
npm install
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
```

Start a local single-node replica set once (any MongoDB 6+):

```bash
mongod --replSet rs0 --dbpath ./data --port 27017
mongosh --eval "rs.initiate()"       # first time only
npm run db:migrate
```

Docker alternative: `docker run -d -p 27017:27017 --name cofoundry-mongo mongo:8 --replSet rs0`
then `docker exec cofoundry-mongo mongosh --eval "rs.initiate()"`.

## Run

```bash
npm run dev        # API on :5000, web on http://localhost:5173 (Vite proxies /api)
```

Production-style run (one origin serves SPA and API):

```bash
npm run build
NODE_ENV=production APP_ORIGIN=https://your-host MONGODB_URI=... npm start
```

Internal readiness probe (loopback only): `curl http://127.0.0.1:5001/ready`.

## Quality checks

```bash
npm run verify       # format check, lint, typecheck, all tests, production build
npm test             # tests only
npm run lint
npm run typecheck
```

Database tests use an in-memory MongoDB replica set by default (downloads a `mongod` binary on first
run). To use an existing server instead set `MONGODB_TEST_URI`; if it is not a replica set also set
`MONGODB_TEST_EXPECT_TRANSACTIONS=false`.

## Packaging

```bash
npm run package:zip -- 01    # writes release/cofoundry-ai-phase-01.zip
```

The ZIP excludes `node_modules`, `.git`, `.env*` (except `.env.example`), build output and caches.

## Team and Git rules

Four developers share **one feature branch**. Claude never commits, pushes or rewrites history.
Each phase report lists who commits which files, in which order, with suggested messages.

| Developer       | Responsibility                                           | Owns (Phase 1)                                                                               |
| --------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Dev 1 — AI      | AI architecture, model integration, evaluation           | `apps/server/src/ai`, `apps/server/test/ai`, `docs/architecture/AI_PROVIDER_ARCHITECTURE.md` |
| Dev 2 — AI      | Question generation, follow-ups, AI testing, calibration | — (no Phase 1 files)                                                                         |
| Dev 3 — Backend | APIs, database, auth, security, business logic           | root tooling, `packages/shared`, rest of `apps/server`, `docs/api`, docs                     |
| Dev 4 — UI/UX   | Frontend, design system, UX                              | `apps/web`                                                                                   |
