# Phase 11 — Collaboration requests and match creation

Date: 18 October 2026. Contract v3.0 Sections 11, 16, 20, 25. Design:
[COLLABORATION_AND_SAFETY.md](../architecture/COLLABORATION_AND_SAFETY.md). Phases 11–14 are
delivered together; see [12](PHASE_12_README.md), [13](PHASE_13_README.md),
[14](PHASE_14_README.md) (test counts and the developer commit plan are in Phase 14).

## What was built

- **Founder** (report page `/founder/interviews/:id`): once the report is ready, an "Invite … to
  collaborate" panel sends `POST /match-requests {briefId, interviewId, candidateUserId, message}`
  with an Idempotency-Key. "Requests" (`/founder/requests`) lists sent requests; the detail page
  shows status, frozen terms, report facts, timeline and Withdraw while pending.
- **Candidate**: the Inbox now has two tabs (interview invitations / collaboration requests, with
  pending counts). The request page shows the message, the terms (hours, commitment,
  compensation, trial cap, creator-owned IP, off-platform payments), report facts including open
  correction requests, and Accept / Decline (optional reason).
- **Match**: accepting creates exactly one Match; both participants see it under "Matches"
  (`/{role}/matches/:id`) with the agreed terms, the sprint section and "End match" (reason
  shared with the other participant). A match is consent to collaborate on the displayed terms,
  not employment or equity — stated on the page.

## Rules enforced on the server

| Rule                    | Behaviour                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership first         | Another founder's brief or interview → 404 (no pair-existence oracle)                                                                         |
| Eligible report         | Same brief and candidate, submitted and evaluated, stored report; quarantined → 409; consent withdrawn or blocked → 409 "no longer available" |
| Accounts, cohort, block | Both active, same cohort, candidate role, no block in either direction — re-checked in the transaction                                        |
| Current gates           | Current profile must pass the brief's hard gates and be open to contributor roles, else 409 GATE_CHANGED                                      |
| One per pair, lifetime  | Unique (briefId, candidateUserId); a second request after decline/withdraw/expiry → 409 DUPLICATE_PAIR                                        |
| Daily limit             | 20 requests per founder per 24 h → 429                                                                                                        |
| Expiry                  | 7 days; enforced in every handler (409 EXPIRED) and by the 60-second sweep                                                                    |
| Accept                  | Candidate only (founder 403); guard write → re-read → CAS pending→accepted → insert match, one transaction                                    |
| Withdraw / decline      | Founder only / candidate only, pending; repeats return the same state                                                                         |
| Automatic withdrawal    | Brief close, block, suspension (reason shown to the other side only as "unavailable")                                                         |
| Match end               | Either participant; cancels an unfinished sprint; terminal. Active match without a sprint ends after 30 days                                  |

Request snapshots: interview id, report version, report score and evidence level at request time,
terms frozen from the brief (`ipPolicyVersion=creator-owned-v3.0`, trial cap 10 h) and minimal
profile snapshots (name, revision, headline — never contact details).

## Endpoints

`POST/GET /match-requests`, `GET /match-requests/:id`,
`POST /match-requests/:id/{accept,decline,withdraw}`, `GET /matches`, `GET /matches/:id`,
`POST /matches/:id/end` — [openapi.yaml](../api/openapi.yaml) 0.14.0.

## Data

Migration 8 creates `match_requests`, `matches`, `relationship_guards`, `audit_events` (and the
Phase 12–14 collections) with the indexes listed in the design doc. Nothing existing changes.

## Tests

`apps/server/test/collaboration.requests.test.ts`: full flow (report → request → inbox → accept
→ exactly one match readable by both, audit events without content); ownership/participation/role
on every route; report readiness, mismatched interview, changed gates, withdrawn consent;
lifetime pair uniqueness, idempotent replay and key reuse with another body; two simultaneous
creates and two simultaneous accepts; rollback when the match insert fails; 7-day expiry in the
handler and in the sweep; withdraw and brief-close withdrawal; daily limit; match end, dormancy,
outsider access. `collaboration.integration.test.ts`: migration 8 indexes, database-level
uniqueness, concurrent accepts over the Mongo stores. Web: inbox tabs and acceptance, unavailable
state, ending a match. E2E: the founder sends the request from the report, the candidate accepts
from the inbox tab.

## Limitations

- **Real MongoDB replica-set transactions were not verified here** (FerretDB has none; the
  in-memory MongoDB binary cannot be downloaded). The rollback test is skipped on such servers.
  Reproduce locally with a replica set:
  `docker run -d -p 27017:27017 mongo:7 --replSet rs0 && docker exec <id> mongosh --eval "rs.initiate()"`,
  then `MONGODB_TEST_URI=mongodb://127.0.0.1:27017/?replicaSet=rs0 npm run test -w @cofoundry/server`
  (or just `npm run test`, which downloads an in-memory replica set where network access allows).
- Brief-close race: accept re-reads the brief inside its transaction and again after commit; a
  match created while a close committed is ended immediately (`brief_closed`), and the close hook
  also ends matches started after `closedAt`. The brief's `transitionRevision` is not written
  inside the transaction (the brief store has no session support yet).
