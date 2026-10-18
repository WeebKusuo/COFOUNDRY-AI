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
| 04    | Startup briefs (draft/publish/close/clone), private resume PDFs, AI interview contracts                        | Done — [PHASE_04_README](docs/phases/PHASE_04_README.md) |
| 05    | Deterministic matching engine match-v3.0: hard gates, exact scoring, grouping                                  | Done — [PHASE_05_README](docs/phases/PHASE_05_README.md) |
| 06    | Recommendation batches (15-minute freshness, privacy re-checks) and founder dashboard                          | Done — [PHASE_06_README](docs/phases/PHASE_06_README.md) |
| 07    | Interview invitations, consent, resume readiness, secure sessions (reconnect, one live window)                 | Done — [PHASE_07_README](docs/phases/PHASE_07_README.md) |
| 08    | Live voice interview: AI interviewer room, adaptive questions, speech-to-text, text-to-speech                  | Done — [PHASE_08_README](docs/phases/PHASE_08_README.md) |
| 09    | Answer and communication evaluation, PII minimisation, coding round (Monaco, Judge0 sandbox)                   | Done — [PHASE_09_README](docs/phases/PHASE_09_README.md) |
| 10    | Rubric, durable evaluation jobs, founder/candidate report, AI reliability                                      | Done — [PHASE_10_README](docs/phases/PHASE_10_README.md) |
| 11    | Collaboration requests from evaluated reports, atomic match creation, match lifecycle                          | Done — [PHASE_11_README](docs/phases/PHASE_11_README.md) |
| 12    | Versioned trial sprint terms, canonical hash, two-party approval                                               | Done — [PHASE_12_README](docs/phases/PHASE_12_README.md) |
| 13    | Sprint submission (HTTPS link, never fetched), criterion review, acknowledgements, completion                  | Done — [PHASE_13_README](docs/phases/PHASE_13_README.md) |
| 14    | Blocking, reports, corrections, moderator case queue, quarantine, suspension, audit trail                      | Done — [PHASE_14_README](docs/phases/PHASE_14_README.md) |
| 15–18 | Privacy (export, deletion), retention jobs, deployment, release                                                | Done                                              |

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
  Briefs: `GET/POST /startups`, `GET/PATCH /startups/:id`, `POST /startups/:id/{publish,close,clone}`
  with Idempotency-Key; draft → open (immutable version 1) → closed; confidential problem/solution
  visible only to the owner, teaser projection for cohort candidates; founder brief dashboard and
  editor; seeded PayPilot brief.
  Resume (Phase 4 amendment): `GET/PUT/DELETE /candidate/resume`, `GET /candidate/resume/file`,
  `GET /candidate/resume/text`; private PDF storage, bounded text extraction, consent, redaction;
  resume section on the candidate profile. AI interview data contracts and integration points
  (no model calls).
  Matching (match-v3.0, deterministic, no AI) and recommendations:
  `POST/GET /startups/:id/recommendations` with stored 15-minute batches, privacy re-checks on
  every read and the founder Candidates dashboard with explained scores
  ([docs/architecture/MATCHING.md](docs/architecture/MATCHING.md)).
  AI technical interviews (Phases 7–10): invitations from a fresh recommendation batch,
  confidentiality acknowledgement and consent, resume readiness, a live interview room with an
  animated voice visualizer, spoken questions (Piper), voice answers (faster-whisper) or typed
  answers, adaptive resume-based questioning, a coding round in the Monaco editor with sandboxed
  test runs (Judge0), durable evaluation jobs and an evidence-based report for both participants
  ([docs/architecture/INTERVIEWS.md](docs/architecture/INTERVIEWS.md)). **No video analysis**:
  the camera is never used.
  Collaboration and safety (Phases 11–14): collaboration requests from an evaluated report (one
  per brief/candidate pair, 7-day expiry), transactional match creation, matches, one versioned
  trial sprint per match approved by both participants on the same version and terms hash,
  HTTPS-link submission (never fetched), criterion-by-criterion review, two acknowledgements,
  blocking with cascading effects, reports and corrections, a moderator case queue with audited
  evidence access, report quarantine, attributed display corrections and account suspension
  ([docs/architecture/COLLABORATION_AND_SAFETY.md](docs/architecture/COLLABORATION_AND_SAFETY.md)).
- **Not yet implemented:** general brief access grants outside an invitation
  (`POST/DELETE /startups/:id/access`), `GET /me/export`, `DELETE /me`,
  `DELETE /consents/assessment/:interviewId`, scheduled retention/deletion jobs for Phases 11–14
  records (Phase 15+). Payments and equity are never processed (records of promises only).
- **Never provided (contract v3.0):** public sign-up, email verification, password reset.
- **Off-platform by contract:** live walkthroughs and payments.

## Stack

TypeScript monorepo (npm workspaces): React 19, Vite 8, Tailwind CSS 4, React Router 7, TanStack
Query 5; Express 5, Mongoose 9, Zod 4, Pino, @node-rs/argon2, pdf.js 6.3.289 (Apache-2.0, resume
text extraction), Monaco Editor 0.56 (MIT, bundled locally, lazy-loaded); Vitest, Testing
Library, Supertest, Playwright. Interviews use a configurable OpenAI-compatible LLM provider
(Groq by default), and an optional Python speech service (`services/speech`: faster-whisper MIT,
Piper GPL-3.0 run as a separate process) and a self-hosted Judge0 CE sandbox (GPL-3.0, separate
service).

```
apps/web         React SPA (design system, landing, sign-in, workspaces)
apps/server      Express API, auth, profiles, briefs, resumes, MongoDB, migrations, seeding, AI
packages/shared  Contract constants, API and auth types, pure helpers (used by both)
services/speech  Internal Python speech service (STT + TTS) for the interview room
e2e/             Playwright browser tests against the real server and built SPA
docs/            Phase reports, OpenAPI spec, architecture notes
scripts/         Packaging script (ZIP per phase)
```

## Requirements

- Node.js **22.13 or newer** (`node -v`; required by pdf.js) and npm 10+
- MongoDB **as a replica set** (production refuses to start without transactions). Tests and E2E
  need nothing: they start an in-memory replica set automatically.
- A private, persistent directory for resume PDFs in production (`RESUME_STORAGE_DIR`, outside
  the web build). Development defaults to `apps/server/var/resumes` (git-ignored).

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
npm run db:seed                      # demo accounts, profiles and the PayPilot brief (idempotent)
```

Docker alternative: `docker run -d -p 27017:27017 --name cofoundry-mongo mongo:8 --replSet rs0`
then `docker exec cofoundry-mongo mongosh --eval "rs.initiate()"`.

`npm run db:seed -- --reset` deletes and recreates demo accounts, their profiles, consent records,
briefs and resumes (including stored resume files); it asks for confirmation. Seeding
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
npm run dev        # API on :5000, web on http://localhost:5173 (Vite proxies /api), speech service if set up
```

Open the app at **http://localhost:5173** (or over https). Browsers only allow the microphone and
camera on secure pages: `http://<your-LAN-IP>:5173` blocks them, and the readiness screen says so.

Production-style run (one origin serves SPA and API):

```bash
npm run build
NODE_ENV=production APP_ORIGIN=https://your-host MONGODB_URI=... npm start
```

Internal readiness probe (loopback only): `curl http://127.0.0.1:5001/ready`.

## AI interview services

Interviews need an LLM provider; voice and code execution are optional and degrade honestly
(typed answers, no coding score). Nothing paid is required. Details and licences:
[docs/architecture/AI_PROVIDER_ARCHITECTURE.md](docs/architecture/AI_PROVIDER_ARCHITECTURE.md).

1. **LLM (Groq free tier).** Create a key at console.groq.com, then set `LLM_PROVIDER=groq`,
   `LLM_API_KEY`, `LLM_INTERVIEWER_MODEL` and `LLM_EVALUATOR_MODEL` (see `.env.example`; check
   the model list first). A self-hosted OpenAI-compatible server works with
   `LLM_PROVIDER=openai-compatible` and `LLM_BASE_URL`.
2. **Speech (voice answers and the server voice).** Needs Python 3.9+; runs on your own
   computer (free, no API key). Once: `npm run speech:setup` — creates `services/speech/.venv`,
   installs faster-whisper and Piper, downloads the voice and the Whisper model (about 0.5 GB)
   and sets `SPEECH_PROVIDER=http`, `SPEECH_SERVICE_URL` and a generated `SPEECH_SERVICE_TOKEN` in
   `.env`. Afterwards `npm run dev` starts it with the API and web app (`npm run speech:dev` runs
   it alone). Without it, answers are typed and questions are read by the browser's on-device
   voice (when the browser has one). See [services/speech/README.md](services/speech/README.md).
3. **Code execution (optional).** Run Judge0 CE ≥ 1.13.1 on a dedicated, isolated host and set
   `CODE_EXECUTION_PROVIDER=judge0`, `JUDGE0_URL`, `JUDGE0_AUTH_TOKEN`
   ([docs/architecture/CODE_EXECUTION.md](docs/architecture/CODE_EXECUTION.md)). Without it, runs are
   disabled and reports show no coding score.

## Quality checks

```bash
npm run verify       # format check, lint, typecheck, all unit/integration tests, build
npm run e2e:install  # once: downloads Playwright's Chromium
npm run test:e2e     # builds, starts a real server + in-memory MongoDB, runs browser tests
npm run test:speech  # Python speech-service unit tests (needs python3; no models required)
```

Automated tests and E2E use deterministic **test doubles** for the LLM, speech service and
sandbox (`mock` providers, refused in production); reports they produce say so.

Database tests use an in-memory MongoDB replica set by default (downloads a `mongod` binary on first
run). To use an existing server set `MONGODB_TEST_URI` (tests) or `E2E_MONGODB_URI` (E2E); if it is
not a replica set also set `MONGODB_TEST_EXPECT_TRANSACTIONS=false` (the transaction rollback test
is then skipped, and collaboration writes run without multi-document transactions — never in
production, where startup refuses to run without them).

## Packaging

```bash
npm run package:zip -- 14-amendment # writes release/cofoundry-ai-phase-14-amendment.zip
```

The ZIP excludes `node_modules`, `.git`, `.env*` (except `.env.example`), build output, caches and
private runtime data (`var/`, e.g. uploaded resumes), Python virtualenvs, caches and downloaded
speech models.

## Team and Git rules

Four developers share **one feature branch**. Claude never commits, pushes or rewrites history.
Each phase report lists who commits which files, in which order, with suggested messages.

| Developer       | Responsibility                                           | Main areas                                       |
| --------------- | -------------------------------------------------------- | ------------------------------------------------ |
| Dev 1 — AI      | AI architecture, model integration, evaluation           | `apps/server/src/ai`, `docs/architecture`        |
| Dev 2 — AI      | Question generation, follow-ups, AI testing, calibration | AI capabilities (later phases)                   |
| Dev 3 — Backend | APIs, database, auth, security, business logic           | `apps/server`, `packages/shared`, `e2e`, tooling |
| Dev 4 — UI/UX   | Frontend, design system, UX                              | `apps/web`                                       |
