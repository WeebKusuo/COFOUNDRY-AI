# Phase 13 — Sprint submission, review and completion

Date: 18 October 2026. Contract v3.0 Sections 12, 13, 20, 23. Design:
[COLLABORATION_AND_SAFETY.md](../architecture/COLLABORATION_AND_SAFETY.md).

## What was built

- **Submission** (candidate, active, before the deadline): one HTTPS link plus an optional note and
  the attestation "The founder may view this link, and it contains no third-party secrets."
  Validated with the WHATWG URL parser: https only, no credentials, no localhost/.local, no IP
  literal, no fragment, no non-standard port, ≤ 2,048 characters. The server never fetches,
  previews or runs it; the link opens only after the external-site notice. No resubmission
  (contract v3.0): the same link again is a harmless repeat, a different link is 409.
- **Review** (founder, within 7 days of submission): every agreed criterion exactly once with
  met / partially met / not met and a 1–500 character evidence-and-feedback reason, plus an
  optional overall summary. The overall outcome is computed (met only if all met, not met if all
  not met, otherwise partially met). One immutable review; no automatic or AI judgement and no
  repository execution.
- **Acknowledgements** (each participant once, within 7 days of the review): receipt, not
  agreement, with an optional disagreement note. Both acknowledgements complete the sprint and the
  match ("Completed trial"). A duplicate acknowledgement returns the current state.
- **Deadlines and terminal states**: missed work deadline (`deadline_missed`), review timeout,
  acknowledgement timeout and participant cancellation (always allowed until completion, including
  a scope dispute) cancel the sprint and end the match while keeping the submission/review record.
  Disputes are raised with "Report a problem with this sprint" (Phase 14, category sprint dispute).
- **Completed trials**: the brief preview's `completedSprintCount` now counts completed sprint
  records of the founder irrespective of outcome ("completed trials", never "successful hires").
- **UI**: submission form with live link validation, review screen listing the agreed criteria,
  acknowledgement form with the receipt notice, visible deadline/review/acknowledgement due dates,
  completed-trial summary and the full sprint history.

## Endpoints

`POST /sprints/:id/{submit,review,acknowledge}` — [openapi.yaml](../api/openapi.yaml).

## Tests

`apps/server/test/collaboration.sprints.test.ts` (Phase 13 part): submit → review → both
acknowledge → completed sprint and match, completed-trials count = 1, and no outbound `fetch`
during submission (AUTH-07); eight invalid links and the missing attestation; only the
contributor submits, a different second link is refused; only the founder reviews; missing,
duplicate and unknown criteria; one immutable review; stale review version on acknowledge (SPR-03);
missed deadline with late submission refused (409 EXPIRED); review and acknowledgement timeouts
via the durable sweep keep submission/review/acknowledgements (SPR-05); concurrent submit and
cancel end in one consistent committed state. Web: link validation and attestation, review form
with every criterion, completed summary. E2E: submission, criterion review and both
acknowledgements to "Completed trial".

## Limitations

- The app records promises; it does not track hours worked or payment status.
- The optional review `summary` field is an extension of the contract's review body.
