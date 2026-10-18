# Phase 14 — Blocking, reporting, corrections and moderation

Date: 18 October 2026. Contract v3.0 Sections 16, 21, 24, 25. Design:
[COLLABORATION_AND_SAFETY.md](../architecture/COLLABORATION_AND_SAFETY.md). This README also
holds the Phase 11–14 test evidence, verification notes and the developer commit plan.

## What was built

**Blocking.** "Block …" controls on request, match and interview pages (both roles; the founder
can also block a candidate from their latest results via the API). `POST /blocks` needs a
legitimate relationship (otherwise 404, so it cannot probe accounts), refuses self-blocks and runs
in one transaction with the pair's RelationshipGuard: pending requests withdrawn, active matches
ended, unfinished sprints cancelled. Then pre-submit interviews are cancelled and the founder's
access to the candidate's answers, code and report ends permanently. The store-backed block
policy replaces `NO_BLOCKS_YET`, so discovery, recommendation re-checks and invitations exclude
blocked pairs; interview accept/start, request create/accept and every sprint transition re-check
the block at the action boundary. The other person sees only "This collaboration is no longer
available" (reason codes are mapped to `unavailable`; no text mentions a block). `GET /blocks`
lists your own blocks; `DELETE /blocks/:id` removes only yours and revives nothing.

**Reporting.** `POST /reports` with target type (person, profile, brief, interview report,
sprint), a structured category (harassment or abuse, inappropriate content, misrepresentation,
spam or scam, privacy violation, sprint dispute, incorrect assessment evidence, other) and a
10–2,000 character description. Legitimate visibility is required; repeats about the same target
link to the open case; 10 cases per user per day. Cases are readable only by the reporter and the
assigned moderator; the target never sees them or the reporter's identity.

**Corrections and appeals.** `POST /corrections` on your own profile or your own interview report.
Open corrections appear on the report (both participants) and in the collaboration request
preview without blocking a decision. A resolved correction can add an attributed display
correction ("CoFoundry moderator") shown to both report participants; original answers, numeric
scores and consent history are never changed. Reports show a "Your claim (not a verified finding)"
label next to the moderator's decision. A disagreement is a new case (no automatic reopening).

**Moderation.** Moderator workspace "Case queue" (`/moderator/cases`): summaries without content,
claim (atomic, open → in_review; report and sprint cases place a 30-day-review dispute hold that
keeps the interview from retention deletion), minimum evidence with participant ids (audited
`case.context_read`), internal notes, and a decision: resolve or dismiss with a resolution text the
reporter sees; optional display correction and report quarantine (report targets) and target
suspension (cases with a target user), each requiring `resolved`. Quarantine stops new requests
from the report and hides the AI-written narrative while answers, code and numbers remain.
Suspension sets the account to suspended, bumps its auth version, deletes its sessions and ends
pending requests, matches, sprints and pre-submit interviews without erasing records. Founders and
candidates get 403 on every `/admin` route; moderators have no interview routes and cannot read
evidence of a case they did not claim. Nothing is decided automatically or by AI; report counts
are shown for context only.

**Audit.** Append-only `audit_events` for requests, matches, sprints, blocks, cases, suspension and
founder report reads — ids, action, request id, time and non-content metadata only.

**Safety & account screen** (both roles): your blocks with Unblock, your reports and correction
requests with status, resolution and any hold. Data export and account deletion are not
implemented in this phase and the screen says so.

## Cross-feature enforcement (tested)

| Surface                   | Effect of a block / safety state                                                        |
| ------------------------- | --------------------------------------------------------------------------------------- |
| Candidate recommendations | Blocked candidates absent from results and counts                                       |
| Interview invitations     | Blocked candidate not invitable; pre-submit interviews cancelled; accept/start re-check |
| Interview report access   | Founder 403 "no longer available"; candidate keeps own access                           |
| Collaboration requests    | Pending withdrawn; new requests refused; accept refused                                 |
| Matches                   | Active matches ended; no new sprint                                                     |
| Trial sprints             | Unfinished sprints cancelled; every transition re-checks the block                      |
| Quarantined report        | New collaboration requests refused; narrative hidden                                    |
| Suspended account         | Sessions rejected; relationships ended; records kept                                    |

## Endpoints

`POST/GET /blocks`, `DELETE /blocks/:targetUserId`, `POST /reports`, `POST /corrections`,
`GET /cases`, `GET /cases/:id`, `GET /admin/cases`, `POST /admin/cases/:id/claim`,
`GET /admin/cases/:id/context`, `POST /admin/cases/:id/notes`, `POST /admin/cases/:id/resolve` —
[openapi.yaml](../api/openapi.yaml) 0.14.0.

## Data

Migration 8: `blocks`, `relationship_guards`, `safety_cases`, `audit_events` (with Phase 11–13
collections). Interview sessions gain optional `blockedAt` and `reportQuarantinedAt`; older records
read as unset. `IdentityStore.suspendUser` sets `status=suspended` and increments `authVersion`.

## Tests

`apps/server/test/safety.test.ts`: block ends match and sprint, cuts report access, removes the
candidate from discovery and leaks no block wording; pending requests withdrawn and pre-submit
interviews cancelled; visibility, self-block and own-list rules; unblock revives nothing;
concurrent block and accept leave no active post-block match (SAFE-01); reports with linking of
repeats and reporter-only visibility; daily case limit; corrections limited to own report/profile
and shown as open to both participants; moderator-only routes, claim races between moderators,
assigned-only evidence, audited access; display correction leaves answers and scores unchanged
(SAFE-02); quarantine refuses new requests and hides narrative; dismissal cannot sanction;
suspension revokes sessions and ends relationships; dispute hold keeps the interview from
retention deletion until resolved. Web: Safety & account page; moderator claim → evidence →
decision. E2E: correction request → moderator claim and resolution → correction visible to the
founder; block from the match page → founder sees only "no longer available" and loses report
access; unblock.

## Independent review

A separate reviewer (no part in writing the code) checked Phases 11–14 against the contract and
reproduced these defects, all fixed with regression tests:

1. A blocked user could still read the other's current public profile → `GET /profiles/:id` is
   404 across a block.
2. After consent withdrawal or a block, the founder still saw the frozen report score on the
   request, and the candidate could still accept → score/evidence hidden from the founder, request
   shown as unavailable, accept refused.
3. Founder access to interview content after a block relied on a post-commit hook → the live block
   is checked on every founder read and on every live candidate action.
4. A brief closing during acceptance could leave an active match on a closed brief → the brief is
   re-read inside the transaction and after commit; a race-created match is ended (`brief_closed`).
5. A moderator could claim a case they were involved in → reporter, target and report/sprint/brief
   participants get 403 on claim and evidence.
6. A paid sprint could change the brief's payment method note → it is fixed (422 otherwise; the form
   shows it read-only); unpaid can no longer become credit/reference.
7. The accepted-without-match repair query never matched → the sweep checks recent acceptances.
8. Smaller: quarantine wording, brief-close cascade always reaches requests, approval checkbox
   resets per version, direct case-summary and per-interview request lookups (no first-page
   assumptions).

## Verification (final run, 18 October 2026)

| Suite                                                    | Result                                       |
| -------------------------------------------------------- | -------------------------------------------- |
| `npm run verify` (format, lint, typecheck, tests, build) | pass                                         |
| Server (Vitest, 30 files)                                | 481 passed, 1 skipped (transaction rollback) |
| Shared (Vitest)                                          | 62 passed                                    |
| Web (Vitest + Testing Library)                           | 125 passed                                   |
| E2E (Playwright, Chromium)                               | 25 passed                                    |
| Speech service (Python)                                  | 8 passed                                     |

Database-backed tests and E2E ran against **FerretDB** (MongoDB wire protocol, no
transactions); the skipped test is the real-transaction rollback test. One earlier E2E run had a
brief-publish step exceed its 5-second wait on FerretDB; it passed on rerun and in the final full
run. Production MongoDB transactions remain unverified here — run the suite against a replica set
(see Phase 11).

## Limitations

- **MongoDB replica-set transactions not verified in this environment** (outstanding blocker).
- Quarantine cannot be lifted yet (a later case cannot clear it); dispute holds are released when
  their case is resolved but the 30-day review is not automated (the moderator sees `reviewAt`).
- No block button on the discovery result cards; founders block from request, match or interview
  pages (the API also accepts candidates from their latest results).
- `GET /me/export`, `DELETE /me`, assessment-consent deletion and retention jobs for Phase 11–14
  records belong to later phases.
- Rate-limit counters are per process.

## Developer commit plan

Claude did not commit, branch, push or rewrite history. **Dev 1 and Dev 2 have no changes in this
batch** (no AI prompt, model, speech, coding-evaluation or reliability code changed; the AI
interview, coding round and report were verified unchanged by the existing suites and the E2E
journey). Commit in this order, then run `npm run verify`:

### Dev 3 — backend, lifecycle, transactions, permissions, security, audit, backend tests

```bash
git add packages/shared/src/collaboration.ts packages/shared/src/safety.ts \
  packages/shared/src/index.ts packages/shared/src/interview.ts packages/shared/src/report.ts \
  apps/server/src/audit apps/server/src/collaboration apps/server/src/db/record-collection.ts \
  apps/server/src/db/transactions.ts apps/server/src/db/migrations.ts \
  apps/server/src/safety apps/server/src/auth/store.ts apps/server/src/briefs/service.ts \
  apps/server/src/http/app.ts apps/server/src/http/routes/v1.ts \
  apps/server/src/http/routes/collaboration.ts apps/server/src/http/routes/safety.ts \
  apps/server/src/index.ts apps/server/src/interviews/records.ts \
  apps/server/src/interviews/service.ts apps/server/src/interviews/store.ts \
  apps/server/src/interviews/view.ts apps/server/src/profiles/service.ts \
  apps/server/src/recommendations/service.ts \
  apps/server/test/collaboration.integration.test.ts apps/server/test/collaboration.requests.test.ts \
  apps/server/test/collaboration.sprints.test.ts apps/server/test/safety.test.ts \
  apps/server/test/db.integration.test.ts apps/server/test/support/collaboration-fixture.ts \
  apps/server/test/support/memory-collaboration-store.ts apps/server/test/support/harness.ts \
  apps/server/test/support/memory-interview-store.ts apps/server/test/support/memory-store.ts \
  e2e/start-server.ts docs/api/openapi.yaml docs/architecture/COLLABORATION_AND_SAFETY.md \
  docs/phases/PHASE_11_README.md docs/phases/PHASE_12_README.md \
  docs/phases/PHASE_13_README.md docs/phases/PHASE_14_README.md
git commit -m "feat(collaboration,safety): requests, matches, versioned trial sprints, blocks, reports and moderation (Phases 11-14)"
```

### Dev 4 — founder/candidate screens, moderation interface, navigation, UI tests

```bash
git add apps/web/src/features/collaboration apps/web/src/features/safety \
  apps/web/src/app/routes.tsx apps/web/src/app/app.test.tsx \
  apps/web/src/features/auth/auth.test.tsx apps/web/src/features/workspace/nav.ts \
  apps/web/src/features/interviews/CandidateInterviewPage.tsx \
  apps/web/src/features/interviews/FounderInterviewPage.tsx \
  apps/web/src/features/interviews/InterviewListPage.tsx \
  apps/web/src/features/interviews/ReportView.tsx \
  apps/web/src/features/interviews/interviews.test.tsx \
  e2e/tests/interviews.spec.ts e2e/tests/responsive.spec.ts README.md
git commit -m "feat(web): collaboration requests, matches, trial sprint, safety and moderation screens (Phases 11-14)"
```

Afterwards `git status` should be clean.
