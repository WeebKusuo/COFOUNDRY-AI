# Collaboration and safety (Phases 11–14)

Contract v3.0 Sections 11–13, 16, 20, 21, 24, 25. Code: `apps/server/src/collaboration/`,
`apps/server/src/safety/`, `apps/server/src/audit/`, `apps/server/src/db/transactions.ts`;
contracts in `packages/shared/src/collaboration.ts` and `safety.ts`; screens in
`apps/web/src/features/collaboration/` and `apps/web/src/features/safety/`.

```
evaluated interview report ─► MatchRequest (pending, 7 days) ─accept─► Match (active)
                                   │ decline / withdraw / expire           │ end / dormant 30 d
                                   ▼                                       ▼
                              terminal request                      TrialSprint (one per match)
                                                                     proposed ⇄ awaiting_approval
                                                                        └─► active ─► submitted
                                                                              ─► reviewed ─► completed
                                                     any non-terminal ─► cancelled / rejected (ends match)
```

## Collections (migration 8)

| Collection            | Key constraints and indexes                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `match_requests`      | unique (briefId, candidateUserId) — one request per pair for the brief's lifetime; candidate+status; status+expiresAt |
| `matches`             | unique requestId; unique (briefId, candidateUserId); founder/candidate lists; status+startedAt (dormancy)             |
| `trial_sprints`       | unique matchId — one sprint per match; status+terms.deadline; founder+status (completed trials)                       |
| `blocks`              | unique directed (blockerUserId, blockedUserId); blockedUserId                                                         |
| `relationship_guards` | one row per unordered user pair (`low:high`), `revision` incremented by every paired mutation                         |
| `safety_cases`        | status+createdAt; reporter+createdAt; targetType+targetId                                                             |
| `audit_events`        | time; targetType+targetId+time. Append-only, ids only, no content                                                     |

Existing data is untouched. Interview sessions gain two optional fields (`blockedAt`,
`reportQuarantinedAt`); records written before Phase 14 read as "never". Run `npm run db:migrate`.

## Transactions and concurrency

Every paired change (request create/accept/decline/withdraw, match end, sprint create and every
sprint transition, block, suspension) runs in `TransactionRunner.run`:

1. write the pair's `RelationshipGuard` row (two transactions on the same pair now write-conflict;
   one aborts and retries, capped at 3 attempts);
2. re-read the request/match/sprint, block and account state inside the transaction;
3. compare-and-set on the record's `rev`, insert dependents (the match on accept), append the audit
   event — all or nothing.

The unique indexes are the final guard: a concurrent second accept either sees the accepted request
or fails the match insert, and returns the match the winner created. Production startup refuses to
run without MongoDB transactions (replica set). **Development and the local E2E run against
FerretDB, which has no transactions**: there the same code runs without a session (logged at
startup). Unique indexes and the `rev` compare-and-set still prevent duplicates, and an accepted
request whose match insert was lost is repaired by retrying the accept or by the 60-second sweep,
but writes are not rolled back together. Real replica-set transaction behaviour is therefore
**not verified in this environment**; `collaboration.integration.test.ts` contains the rollback test
and runs it only when the test server supports transactions.

Interview sessions keep their Phase 7 optimistic per-record writes; a block cancels pre-submit
interviews right after the block transaction commits, and every interview action re-checks the
block first.

## Time rules

Authoritative deadlines are server-side only. Handlers apply them synchronously before acting, and
the 60-second sweep (`CollaborationService.sweep`, `SprintService.sweep`) applies them durably:

| Rule                                       | Effect                                                   |
| ------------------------------------------ | -------------------------------------------------------- |
| request pending and now ≥ expiresAt (7 d)  | `expired`; accept/decline answer 409 EXPIRED             |
| proposal not active by its deadline        | sprint `cancelled/proposal_expired`, match ended         |
| active sprint reaches its deadline         | `cancelled/deadline_missed`, match ended; no late submit |
| submitted 7 d without review               | `cancelled/review_timeout`, submission kept              |
| reviewed 7 d without both acknowledgements | `cancelled/acknowledgement_timeout`, review kept         |
| active match without sprint for 30 d       | match `ended/inactivity`                                 |
| brief closed while a request was accepted  | the race-created match is ended (`brief_closed`)         |

## Sprint terms and approvals

Hours are whole 1–10 (policy constant, `TRIAL_CAP_HOURS`); the deadline must be after now and at
most 14 days ahead at send and approve; compensation keeps or improves the brief's terms (amount
not lower, payment not later, unpaid/credit can only improve to paid). The canonical `termsHash` is
SHA-256 over sorted-key JSON of scope, deliverables, criteria (with server ids), hours, deadline,
compensation and IP policy version. Every PATCH increments the version, recomputes the hash, clears
all approvals and returns to `proposed`; history keeps every version for comparison. `send` records
the proposer's approval of the current version; `approve` must name the current version **and**
hash (409 VERSION_CONFLICT otherwise) and only the non-proposer may call it. Non-monetary terms need
`acknowledgeUnpaid: true` from both sides. Approval identities come from the session, never the
body. There is no payment processing or equity transfer anywhere.

## Blocking

A block is allowed only towards someone you have a legitimate relationship with (interview,
request or match, or — for founders — a candidate in your latest results); otherwise 404. Effects:
pending requests withdrawn, active matches ended and unfinished sprints cancelled (same
transaction); pre-submit interviews cancelled; the founder's access to the candidate's assessment
(answers, code, report) ends permanently; the candidate disappears from the founder's discovery.
Both keep the minimal historical record (terms, approvals, submission, review). The other person
only ever sees "This collaboration is no longer available": API reason codes are mapped to
`unavailable` and no timeline text mentions a block. Unblocking removes only the caller's own
record and revives nothing.

## Reports, corrections and moderation

- `POST /reports` — target types user, profile, brief, report, sprint with a structured category;
  reporter must have legitimate visibility; a repeat on the same open target links to the open case;
  10 cases per user per day.
- `POST /corrections` — own profile or own interview report. Open corrections are shown on the
  report and the request preview; they never block a human decision or change scores.
- Cases are visible to the reporter (own text, status, resolution) and to the assigned moderator
  only. Targets never see cases; reporter identity appears only in the assigned moderator's context.
- Moderators (role `moderator`) list summaries without content, claim atomically, read the minimum
  evidence (audited `case.context_read`), add internal notes and resolve. Report and sprint cases
  place a dispute hold (reviewed every 30 days) that keeps the related interview from retention
  deletion until the case is resolved.
- Resolution can add an attributed display correction (report targets), quarantine a report (no new
  requests can use it; the AI-written narrative is hidden, answers/code/numbers stay) or suspend the
  case's target user (sessions revoked, pending requests/matches/sprints/interviews ended, records
  kept). Quarantine and suspension require `decision=resolved` and a resolution text. Moderators
  cannot edit answers, numeric scores or consent history; nothing is decided automatically or by AI.

## Audit trail

`audit_events` records request created/accepted/declined/withdrawn, match ended, sprint
created/revised/sent/approved/rejected/cancelled/submitted/reviewed/acknowledged, block created/removed,
case opened/claimed/context_read/note_added/resolved, user suspended and founder report reads. Each
event stores the actor id, action, target, request id, time and non-content metadata only.
