# Phase 12 — Match lifecycle and mutually approved trial sprint

Date: 18 October 2026. Contract v3.0 Sections 12, 13, 16, 20. Design:
[COLLABORATION_AND_SAFETY.md](../architecture/COLLABORATION_AND_SAFETY.md).

## What was built

- **Proposal** (`POST /matches/:id/sprints`): either participant may propose (the contract allows
  both; the founder is the usual proposer and the founder is always the reviewer, the candidate
  always the contributor). Fields: title, scope (50–2,000), 1–5 deliverables, 1–5 measurable
  acceptance criteria (server-generated ids), expected effort (whole 1–10 total hours), UTC
  deadline (after now, ≤ 14 days ahead), compensation, fixed creator-owned IP notice and the
  hour-cap notice. One sprint per match.
- **Versioned terms**: every `PATCH /sprints/:id` (proposer, `expectedVersion`) creates a new
  version, recomputes the canonical SHA-256 `termsHash`, clears all approvals and returns to
  `proposed`. The UI keeps every version and shows a field-by-field comparison with any earlier
  version.
- **Explicit approvals**: `send` records the proposer's approval of the current version;
  `approve` (the other participant) must carry the current `expectedVersion` and `termsHash`;
  both approvals of the same version and hash start the sprint (`active`, `startedAt`). The UI
  requires ticking "I approve version N of these terms exactly as shown (hash…)" and, for
  credit/reference or unpaid terms, "No monetary payment promised" (`acknowledgeUnpaid`, refused
  for paid terms). No consent is defaulted.
- **Reject / cancel**: the non-proposer rejects a sent proposal (terminal, match ends); either
  participant cancels any non-terminal sprint (match ends; history and approvals of an active
  sprint are kept, approvals of an unstarted proposal cleared).
- **Compensation floor**: same type and details as the brief, or improved (higher amount, earlier
  payment, unpaid/credit → paid). Lower pay, later payment or a downgrade is 422 with field errors.
  No payment is processed and no payment status is stored.

## Invariants

| Invariant                    | Enforcement                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| Founder cannot approve alone | Proposer's `approve` → 403; activation requires both user ids' approvals                       |
| No stale approval            | `expectedVersion` + `termsHash` must match → else 409 VERSION_CONFLICT                         |
| Edits invalidate approvals   | PATCH clears approvals, increments version, new hash                                           |
| Active terms immutable       | PATCH outside proposed/awaiting_approval → 409                                                 |
| One sprint, no revival       | Unique matchId; terminal statuses accept no transition                                         |
| Deadline window              | Checked at create, PATCH, send and approve; proposal deadline passing → cancelled, match ended |
| Replays                      | Idempotency-Key on every POST; repeating a reached state returns it                            |

## Endpoints

`POST /matches/:id/sprints`, `GET/PATCH /sprints/:id`,
`POST /sprints/:id/{send,approve,reject,cancel}` — [openapi.yaml](../api/openapi.yaml).

## Tests

`apps/server/test/collaboration.sprints.test.ts` (Phase 12 part): propose → send → approve
identical version → active, with audit events; an unsent draft cannot be approved or rejected;
the founder cannot approve; edit → new version/hash, approvals cleared, stale version and stale
hash refused, then approval of the new version (SPR-01); hours 11/0/5.5, past and > 14-day
deadlines, lower pay, later payment, downgrade, empty deliverables, short scope (SPR-02);
unpaid acknowledgement on send and approve; candidate as proposer; one sprint per match; active
terms immutable; rejection terminal and match ended; cancellation; proposal expiry; outsider
access. Web: approval requires the explicit checkbox and sends version + hash; non-monetary
acknowledgement; version comparison. E2E: founder proposes and sends, candidate approves.

## Limitations

- Transactions: see Phase 11 (not verified against a real replica set here).
- The proposal deadline is entered in the viewer's local time and stored in UTC.
