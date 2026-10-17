# CoFoundry AI

Find the people your startup is missing. Test the fit. Build together.

CoFoundry AI helps a founder find a backend contributor, assess fit with a transparent interview
and agree a bounded trial sprint. The engineering source of truth is
**Implementation Contract v3.0** (PDF shared with the team, not stored in this repository).

## Project status

| Phase | Scope                                                                                                          | Status                                                   |
| ----- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 01    | Foundation: monorepo, design system, landing, role layouts, API foundations, MongoDB, AI-provider architecture | Done — [PHASE_01_README](docs/phases/PHASE_01_README.md) |
| 02    | Authentication and security: seeded accounts, sessions, CSRF, RBAC, sign-in UI, E2E tests                      | Done — [PHASE_02_README](docs/phases/PHASE_02_README.md) |
| 03    | Candidate and founder profiles: skills, projects, availability, discovery consent, privacy-safe projection     | Done — [PHASE_03_README](docs/phases/PHASE_03_README.md) |
| 04–18 | Briefs, matching, interviews, requests, sprints, safety, privacy, deployment                                   | Not started                                              |

What exists today versus what is deferred:

- **Implemented:** health; `GET /auth/csrf`, `POST /auth/login`, `POST /auth/logout`, `GET /me`;
  Argon2id passwords; HttpOnly session cookies (8 h absolute, 30 min idle); CSRF tokens; exact
  Origin checks; login and general rate limits; deny-by-default route protection and server-side
  role checks; users/sessions collections with migrations; idempotent demo seeding; sign-in page;
  protected founder / candidate / moderator workspaces; AI-provider registry (all `disabled`).
  Profiles: `GET/PUT /candidate/profile`, `GET/PUT /founder/profile`, `GET /profiles/:userId`
  (public projection); skills with levels, up to 5 projects with skill tags and optional HTTPS
  link, interests, availability, contributor preference; versioned discovery consent; profile
  editor with live preview; seeded Section 26 demo profiles.
- **Not yet implemented:** briefs, matching and every later product feature route; worker jobs;
  blocks (they will further restrict profile visibility).
  Workspace screens beyond the overview say "Not available yet".
- **Never provided (contract v3.0):** public sign-up, email verification, password reset,
  resume upload or parsing.
- **Off-platform by contract:** live walkthroughs and payments.

## Stack

TypeScript monorepo (npm workspaces): React 19, Vite 8, Tailwind CSS 4, React Router 7, TanStack
Query 5; Express 5, Mongoose 9, Zod 4, Pino, @node-rs/argon2; Vitest, Testing Library, Supertest,
Playwright.

```
apps/web         React SPA (design system, landing, sign-in, workspaces)
apps/server      Express API, auth, MongoDB, migrations, seeding, AI-provider architecture
packages/shared  Contract constants, API and auth types, pure helpers (used by both)
e2e/             Playwright browser tests against the real server and built SPA
docs/            Phase reports, OpenAPI spec, architecture notes
scripts/         Packaging script (ZIP per phase)
```

## Requirements

- Node.js **22.12 or newer** (`node -v`) and npm 10+
- MongoDB **as a replica set** (production refuses to start without transactions). Tests and E2E
  need nothing: they start an in-memory replica set automatically.

## Setup

```bash
npm install
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
```

Start a local single-node replica set once (any MongoDB 6+), then migrate and seed:

```bash
mongod --replSet rs0 --dbpath ./data --port 27017
mongosh --eval "rs.initiate()"       # first time only
npm run db:migrate
npm run db:seed                      # creates demo accounts and profiles (idempotent)
```

Docker alternative: `docker run -d -p 27017:27017 --name cofoundry-mongo mongo:8 --replSet rs0`
then `docker exec cofoundry-mongo mongosh --eval "rs.initiate()"`.

`npm run db:seed -- --reset` deletes and recreates demo accounts, their profiles and consent
records (asks for confirmation). Seeding
runs only with `DEMO_MODE=true` and refuses any database containing pilot accounts.

### Demo accounts

Password: the value of `SEED_DEMO_PASSWORD` (`.env.example` uses `cofoundry-demo-2026`). These are
shared demo identities — never use them for real people.

| Role               | Email                                                                              |
| ------------------ | ---------------------------------------------------------------------------------- |
| Founder (PayPilot) | `founder@demo.cofoundry.test`                                                      |
| Candidates         | `asha@`, `dev@`, `isha@`, `kabir@`, `mira@`, `nila@`, `hidden@demo.cofoundry.test` |
| Moderator          | `moderator@demo.cofoundry.test`                                                    |

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
npm run verify       # format check, lint, typecheck, all unit/integration tests, build
npm run e2e:install  # once: downloads Playwright's Chromium
npm run test:e2e     # builds, starts a real server + in-memory MongoDB, runs browser tests
```

Database tests use an in-memory MongoDB replica set by default (downloads a `mongod` binary on first
run). To use an existing server set `MONGODB_TEST_URI` (tests) or `E2E_MONGODB_URI` (E2E); if it is
not a replica set also set `MONGODB_TEST_EXPECT_TRANSACTIONS=false`.

## Packaging

```bash
npm run package:zip -- 03    # writes release/cofoundry-ai-phase-03.zip
```

The ZIP excludes `node_modules`, `.git`, `.env*` (except `.env.example`), build output and caches.

## Team and Git rules

Four developers share **one feature branch**. Claude never commits, pushes or rewrites history.
Each phase report lists who commits which files, in which order, with suggested messages.

| Developer       | Responsibility                                           | Main areas                                       |
| --------------- | -------------------------------------------------------- | ------------------------------------------------ |
| Dev 1 — AI      | AI architecture, model integration, evaluation           | `apps/server/src/ai`, `docs/architecture`        |
| Dev 2 — AI      | Question generation, follow-ups, AI testing, calibration | AI capabilities (later phases)                   |
| Dev 3 — Backend | APIs, database, auth, security, business logic           | `apps/server`, `packages/shared`, `e2e`, tooling |
| Dev 4 — UI/UX   | Frontend, design system, UX                              | `apps/web`                                       |
