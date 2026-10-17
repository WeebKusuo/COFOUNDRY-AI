# Phase 04 — Startup briefs, resume PDFs and AI interview contracts

Date: 17 October 2026. Baseline: Implementation Contract v3.0 (Sections 03, 06, 13, 14, 16–18, 23,
25, 26) plus the Phase 4 amendment, which adds resume PDFs and prepares the AI interview system.
Where the amendment conflicts with v3.0 (v3.0 defers uploads and rejects all non-JSON bodies), the
amendment wins — for exactly one route.

## What was built

### Startup briefs (Sections 06, 14, 18)

| Route                          | Behaviour                                                                                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /startups?scope=mine`     | Founder role. Own briefs in every state, newest first, opaque cursor, limit ≤ 50.                                                                                                                          |
| `GET /startups?scope=discover` | Candidate role. Teasers of **open** briefs from active founders in the candidate's cohort; own briefs excluded (no self-pairing).                                                                          |
| `POST /startups`               | Founder role, Idempotency-Key. Draft with title required, everything else optional; version 0. Server fields (status, version, role, work mode, IP policy, dates) are rejected.                            |
| `GET /startups/:id`            | Owner → `{access: owner, brief, preview}`. Cohort candidate + open brief → `{access: preview, preview}`. Everything else (drafts, closed, other cohorts, other founders, moderators, malformed ids) → 404. |
| `PATCH /startups/:id`          | Owner, draft only. `{expectedVersion, changes}`; version +1 per edit; stale → 409 `VERSION_CONFLICT`; published → 409 `INVALID_STATE`.                                                                     |
| `POST /startups/:id/publish`   | Idempotency-Key. Full validation → open **version 1**. Missing fields → 422 with `brief.<field>` errors; no required skill above team coverage → 422 `NO_SKILL_GAP`.                                       |
| `POST /startups/:id/close`     | Idempotency-Key. Open → closed with a 0–500 character reason; drafts → 409. Closed briefs never reopen.                                                                                                    |
| `POST /startups/:id/clone`     | Idempotency-Key. New draft (version 0, `clonedFromId`) with the same content; the original is untouched.                                                                                                   |

All Section 03/13 rules are enforced at the route boundary and again at publish: title 1–100,
teaser 50–500, problem and solution 50–3,000, 1–5 industry and mission tags, 1–8 distinct required
skills (level 1–5, importance 1–5, mandatory flag), team coverage 0–5 per canonical skill
(missing = 0), hours 1–40, months 1–12, compensation `paid` (amount in paise ≥ 1, INR, payer
founder, due 1–30 days, method note 1–300) / `credit_reference` (20–500) / `unpaid`. Text is
NFKC-normalised; skill aliases resolve; unknown fields are 422. Role, opportunity, work mode and
the creator-owned IP policy are server constants.

**Confidentiality.** v3.0 defines no founder-adjustable confidentiality settings, so none were
invented. The applicable rule is fixed: problem and solution (and team coverage, close reason and
the founder's id) are confidential and appear only in the owner projection. The teaser projection
shows title, teaser, role, required skills, hours/months, compensation, IP policy, trial cap (10 h),
founder display name, self-reported company link and completed trials (0 until sprints exist). The
full-brief access grant (`POST/DELETE /startups/:id/access`, conf-v3.0 acknowledgement) belongs to
the invitation flow and is **not** in this phase, so no one but the owner can read a full brief yet.

**Founder dashboard.** Brief list with status tabs and counts, create flow, draft editor (basics,
confidential idea, industry and mission, required skills with live gap indicator, team coverage,
time, compensation, fixed IP notice, publish checklist using the shared validator, confirmation
before publishing), candidate preview, published read-only view with clone and close (with
reason), overview card, loading/empty/not-found/conflict/validation states, sticky save bar.

### Resume PDFs (Phase 4 amendment)

| Route                        | Behaviour                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /candidate/resume`      | Candidate role. Metadata, current version, consent state. Never storage keys or paths.                                                                                                  |
| `PUT /candidate/resume`      | Raw `application/pdf` body (never multipart), ≤ 5 MiB, consent header `X-Resume-Consent: resume-processing-v1`, `X-Expected-Version`, optional `X-Filename`. 10 per hour per candidate. |
| `DELETE /candidate/resume`   | Removes metadata and text, then the file, then withdraws consent. Idempotent, 204.                                                                                                      |
| `GET /candidate/resume/file` | Owner download: `attachment`, `nosniff`, `Content-Security-Policy: sandbox`, `no-store`.                                                                                                |
| `GET /candidate/resume/text` | Owner view of the redacted text an interview service would receive (emails, phone numbers and links removed).                                                                           |

- **Validation:** content type, `%PDF-` header and `%%EOF` trailer, size limit enforced by the raw
  parser (413) after session, Origin and CSRF checks.
- **Bounded extraction:** pdf.js 6.3.289 (Apache-2.0) runs in a worker thread with a 256 MB heap,
  15 s timeout (terminated on expiry), eval disabled, no font loading or fetching; at most 10 pages
  and 30,000 characters (marked `truncated`). Malformed, password-protected, too-slow or too-complex
  PDFs are rejected with a clear message and never stored. PDFs without text (scans) are stored
  with status `no_text`.
- **Storage:** a `ResumeFileStorage` interface; the default implementation writes to a private
  directory (`RESUME_STORAGE_DIR`, required in production, refused inside the web build;
  development default `apps/server/var/resumes`, git-ignored and excluded from ZIPs). Directory
  0700, files 0600, random 128-bit keys, atomic write-then-rename. The display filename is
  sanitised and never used for paths. No paid or external storage dependency.
- **Versioned metadata:** `candidate_resumes` holds one document per candidate: last version
  issued (never reused, even after deletion), filename, size, file SHA-256, page counts, extraction
  status, extractor version, text SHA-256 and the extracted text.
- **Access:** only the candidate's own session. Founders receive nothing: no route, no field in
  any projection. Interview-processing code reads it only through
  `ResumeService.readForInterviewProcessing`, which re-checks consent and extraction status.
- **Consent and deletion:** upload requires the current notice version; consent is recorded
  (`consent_records`, purpose `resume_processing`) before the resume becomes visible to any
  processing path; deleting withdraws it. Candidates without a resume are fully supported.
- **UI:** a "Resume (optional)" section in the existing candidate profile, independent of the
  profile save: privacy notice, consent checkbox, client-side type/size checks, metadata, download,
  extracted-text view, replace, delete with confirmation, `no_text` and truncation notices.

### AI interview contracts (no AI is run)

`packages/shared/src/interview.ts` (`ai-interview-contract-v1`), `apps/server/src/ai/contracts.ts`
and `apps/server/src/interviews/resume-question-input.ts` define: the resume-to-question-generation
input (redacted resume text, self-reported skills/projects, required skills — no ids, names,
contact details, links or brief problem/solution), versioned `ResumeRef` for future sessions,
`InterviewResumeBinding` (`resume_based` or `profile_only` with the reason), strict output schemas
plus an exact-substring evidence check, a separate `follow_up_generation` capability for the
user's adaptive follow-up API, four separate analysis categories (only technical correctness can
score; language, audio and video carry `affectsTechnicalScore: false`), and media consent
(`interview-media-v1`: webcam, microphone and technical analysis required; recording and the
other analyses optional and never penalised). Model policy (free, open-source, preferably
self-hostable, licence verified) is in `docs/architecture/AI_PROVIDER_ARCHITECTURE.md`. No room,
avatar, speech, video analysis, scoring or reports were built.

## Architecture decisions

- **Idempotency without transactions.** Section 25 asks for the idempotency record to be written in
  the same transaction as the mutation. Because transactions are still unverified here (below),
  the record is **reserved before** the mutation and carries the resource id the mutation will
  use. A retry after a crash finds the reservation and repeats the mutation for that id, which
  every operation makes safe (create returns the existing record; transitions return the reached
  state), so a retry can never create a duplicate. Same key + different body → 409; a failed
  attempt releases the key; completed keys replay the current resource after re-checking access;
  records expire after 24 h and are purged by the existing sweeper (no TTL index).
- **Conditional single-document writes** for every brief mutation (`{_id, founderUserId, status,
version}` in the filter), so ownership, state and version are checked atomically.
  `transitionRevision` increments on publish and close for the later race guards of Section 25.
  Closing has no dependent records yet; the Section 06 close effects will run in a transaction
  when interviews and requests exist.
- **One raw-body exemption.** `createJsonBodyGuard` keeps "JSON only, never multipart" for every
  route and allows `application/pdf` solely on `PUT /api/v1/candidate/resume`.
- **Ordered resume writes** (file → consent → metadata on upload; metadata → file → consent on
  delete) so a failure never leaves processable content without consent; a crash after the file
  write can leave an unreferenced file (see limitations).
- **Portable queries.** FerretDB rejects projections inside `findAndModify`; the resume store
  avoids them, and all new code uses `returnDocument` instead of the deprecated `new` option.
- **Linear-time redaction.** All redaction patterns use bounded quantifiers; tested on 200,000
  character hostile inputs (an unbounded email pattern took 70 s before the fix).
- **Field added for an accepted input:** `closeReason` stores the reason that `POST close` accepts.
  `seedKey` (briefs) is storage-internal, as for users.

## Migrations (additive only)

| #   | Name                             | Creates                                                                                                                                                                          |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | `startup-briefs-and-idempotency` | `startup_briefs` (`founderUserId_status`, `founderUserId_createdAt`, `status_createdAt`, unique sparse `seedKey`); `idempotency_records` (unique `actor_route_key`, `expiresAt`) |
| 5   | `candidate-resumes`              | `candidate_resumes` (unique `userId`)                                                                                                                                            |

Existing collections and data are untouched; the consent purpose list gains `resume_processing`.
`npm run db:seed` adds the Section 26 PayPilot brief as open version 1 (validated by the publish
rules at seed time); `--reset` also removes demo briefs, idempotency records, resumes and their
files.

## Setup

```bash
npm install                        # Node 22.13+ (pdf.js requirement; was 22.12)
cp .env.example .env               # optional: RESUME_STORAGE_DIR (required in production)
npm run db:migrate && npm run db:seed
npm run dev                        # founder@ → Briefs; asha@ → Profile → Resume
npm run verify
npm run test:e2e
```

Test fixtures are generated by `apps/server/test/fixtures/resumes/generate.py` (fictional data).

## Results (executed 17 Oct 2026)

| Suite                                                                                                                      |   Tests | Result   |
| -------------------------------------------------------------------------------------------------------------------------- | ------: | -------- |
| `@cofoundry/shared` (2 files)                                                                                              |      36 | pass     |
| `@cofoundry/server` (16 files; new: briefs 29, resumes 25, AI contracts 3, rate limits 1, config 2, Phase 4 integration 9) |     260 | pass     |
| `@cofoundry/web` (7 files; new: briefs 14, resume 6)                                                                       |      95 | pass     |
| Playwright E2E (desktop + mobile Chromium; new: briefs 2, resume 1, mobile brief/resume 1)                                 |      17 | pass     |
| **Total**                                                                                                                  | **408** | **pass** |

`npm run verify` exit 0 (Prettier, ESLint 0 warnings, TypeScript incl. `e2e/`, production build).
Also checked by hand: the bundled production server (`apps/server/dist`) extracted a fixture
resume and deleted it; screens reviewed at 1440 px light and dark and at 390 px.

**Independent review.** A separate review agent audited the brief and resume code. It confirmed
no defect in brief confidentiality or idempotency and found four resume defects, all fixed with
regression tests: phone numbers inside longer digit runs and links without `https://` escaped
redaction; long non-ASCII filenames failed validation after the file and consent were written
(now bounded by UTF-16 length, and any failed save rolls back the file and newly granted consent);
an upload racing a delete in another tab could store a resume without consent (deletion now
issues a new version, so the stale upload conflicts). Also adopted: at most 2 concurrent PDF
extractions, a 20-character minimum for the resume quote behind each generated question, a
founder-role check on brief previews and symlink-resolved storage-directory checks.

**Environment blocker — real MongoDB replica-set transactions still not verified here.** The
sandbox cannot download MongoDB, so database tests and E2E ran against FerretDB 1.24 with
`MONGODB_TEST_EXPECT_TRANSACTIONS=false`; FerretDB has no transactions, so nothing about the
transaction path is proven by these runs. Phase 4 deliberately does not depend on transactions.
On team machines the same commands use an in-memory replica set by default — please run
`npm test` and `npm run test:e2e` once and report the result.

## Limitations and open items

1. Real replica-set transaction path unverified in this environment (above).
2. Full-brief access grants, blocks and participant access are later phases; until then only the
   owner can read problem/solution.
3. A crash between writing a resume file and saving its metadata leaves an unreferenced file in
   the private directory (never served). A cleanup job is needed before a pilot.
4. Resume files are not encrypted at rest; protect `RESUME_STORAGE_DIR` with disk encryption and
   backups that follow the deletion rules. Local disk suits the single-instance demo only.
5. Redaction removes emails, phone numbers and links, not names or postal addresses. The question
   input never carries identity fields, but resume text itself may still contain a name.
6. No OCR: scanned resumes are stored as `no_text` and interviews fall back to profile questions.
7. In-memory rate limits (single instance). The E2E server raises only the CSRF bootstrap limit
   (the suite signs in many times per minute); its real value is unit-tested.
8. pdf.js pulls the optional `@napi-rs/canvas` (MIT) for rendering; text extraction does not use it.
9. PDFs encrypted with only an owner password (no open password) are readable and accepted; PDFs
   that need a password to open are rejected.
10. Consent checks look for an active `resume-processing-v1` record but not its version; when the
    notice text changes, the version bump must also require fresh consent.

## Assigned developers and suggested commits

Run `npm run verify` after the **last** commit: the shared index, server tests and UI reference
files from several owners, so intermediate commits are not guaranteed to build on their own.

**1. Dev 3 (Backend)** — shared brief/resume contracts, brief and resume APIs, idempotency,
storage, migrations, seed, config, server tests.

```powershell
git add .env.example .gitignore package.json package-lock.json scripts/package-zip.mjs packages/shared/src/brief.ts packages/shared/src/resume.ts packages/shared/src/index.ts packages/shared/src/profile.ts packages/shared/test/phase4.test.ts apps/server/package.json apps/server/src/auth/store.ts apps/server/src/briefs apps/server/src/resumes apps/server/src/config/env.ts apps/server/src/db apps/server/src/http apps/server/src/lib/canonical-json.ts apps/server/src/index.ts apps/server/src/profiles/models.ts apps/server/test/briefs.test.ts apps/server/test/resumes.test.ts apps/server/test/phase4.integration.test.ts apps/server/test/rate-limits.test.ts apps/server/test/config.test.ts apps/server/test/db.integration.test.ts apps/server/test/helpers.ts apps/server/test/support apps/server/test/fixtures
git commit -m "feat(briefs,resumes): add startup brief lifecycle, idempotency and private resume PDFs"
```

**2. Dev 1 (AI)** — interview data contracts, analysis separation, media consent, model policy.

```powershell
git add packages/shared/src/interview.ts apps/server/src/ai/types.ts apps/server/src/ai/index.ts docs/architecture/AI_PROVIDER_ARCHITECTURE.md
git commit -m "feat(ai): define interview contracts, analysis categories and media consent"
```

**3. Dev 2 (AI)** — question-generation and follow-up integration points.

```powershell
git add apps/server/src/ai/contracts.ts apps/server/src/interviews apps/server/test/ai/contracts.test.ts
git commit -m "feat(ai): add resume question-generation input, output schemas and evidence check"
```

**4. Dev 4 (UI/UX)** — founder brief dashboard, editor and preview; resume section.

```powershell
git add apps/web
git commit -m "feat(web): add founder brief dashboard and candidate resume management"
```

**5. Dev 3 (Backend)** — E2E tests, API spec and docs.

```powershell
git add e2e docs/api/openapi.yaml docs/phases/PHASE_04_README.md README.md
git commit -m "test(e2e): cover briefs, resumes and privacy; docs for phase 4"
```

Run `git status` afterwards — nothing should remain unstaged.
