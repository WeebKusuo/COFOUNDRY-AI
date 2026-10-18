# Phase 07 — Interview invitations and session preparation

Date: 18 October 2026. Specification: "CoFoundry AI — Phases 7–10" (supersedes the interview
parts of Implementation Contract v3.0 Sections 07–09; the v3.0 invitation and lifecycle rules are
kept unless superseded). Architecture: [INTERVIEWS.md](../architecture/INTERVIEWS.md).
Phases 7–10 are delivered together; see also [08](PHASE_08_README.md), [09](PHASE_09_README.md),
[10](PHASE_10_README.md).

## What was built

**Invitations (founder).** The recommendation dashboard's "Invite to interview" is now live: a
confirmation step, then `POST /interviews {briefId, candidateUserId, batchId}` with an
Idempotency-Key. The server calls the Phase 6 boundary `resolveForInvitation` (unexpired batch of
the owned open brief, listed and still-visible candidate, unchanged profile revision, re-passed
hard gates → otherwise 409 `STALE_RECOMMENDATION`), refuses self-invites, enforces one
interview per brief/candidate pair (409 `DUPLICATE_PAIR`, unique index) and 20 invitations per
founder per 24 hours (429). Invitations expire after 7 days. The brief teaser and full brief are
frozen on the session. Founders get an Interviews list and a detail page (progress only until
submission; cancel with a reason).

**Invitations (candidate).** Inbox list, invitation page with the teaser and terms, the
confidentiality acknowledgement (`POST /interviews/:id/brief-access`, recorded as a
`brief_access` ConsentRecord) that releases the full brief, then acceptance with:

| Consent (`interview-ai-v1`) | Required | Purpose                                                                  |
| --------------------------- | -------- | ------------------------------------------------------------------------ |
| `assessment`                | yes      | Take the AI-assisted assessment and share results with this founder      |
| `external_ai_processing`    | yes      | Resume text, answers and code are processed by the disclosed AI provider |
| `speech_transcription`      | no       | Answer by voice; without it every answer is typed, with no penalty       |

There is **no webcam item**: the camera is never requested. Acceptance requires the current
profile revision (409 `VERSION_CONFLICT` otherwise), snapshots the profile, re-checks the hard
gates (409 `GATE_CHANGED`), records the provider labels shown (e.g.
`groq:llama-3.3-70b-versatile`) and an `assessment` ConsentRecord, and is refused (503) when no
AI provider is configured. Decline (with an optional reason) is terminal. Withdrawing consent
cancels a pre-submit interview.

**Resume preparation.** The interview uses the candidate's Phase 4 resume text only (never the
PDF). `prepareResumeForInterview` requires a stored resume, successful text extraction and active
`resume_processing` consent; otherwise start is refused with 409 `RESUME_REQUIRED` and an
actionable message ("Upload your English resume…", "no extractable text (it may be a scanned
image)…", "consent is missing…"). There is no fallback to generic profile questions. The text is
contact-redacted, then names/credentials/government ids/labelled personal fields are removed
best-effort, bounded to 12,000 characters and frozen on the session with the resume reference;
text resembling instructions to the AI is flagged.

**Readiness screen** (`/candidate/interviews/:id/prepare`): instructions and duration (about 40
minutes), microphone permission with a live level meter, AI voice check (TTS), resume status
with a link to the profile, consent summary and provider, coding instructions (languages,
visible/hidden tests, sandbox availability) and the privacy/retention notice. Start is disabled
until the resume and AI interviewer are ready.

**Secure sessions.** `POST /start` (header `X-Interview-Client`, a per-tab id) creates the
`in_progress` session, the fixed spoken introduction and the deadlines (conversation 20 min,
global 45 min). One live window: another tab sees "open in another window" and must take over
(`/attach`); stale windows get 409 `ACTIVE_ELSEWHERE`; repeated start attaches instead of
creating a second session. Reconnecting (same tab) returns the same question and deadlines;
disconnected time is never added back. Heartbeats every 15 s. Every write is a conditional
replace on `rev`; a 15-second sweeper and every read apply expiry and deadlines. Closing a brief
cancels its invited/accepted/in-progress interviews.

**Persistence.** Migration 7: `interview_sessions` (unique brief+candidate; founder/candidate
list, status+expiresAt, status+globalDeadline and invitedAt indexes), `evaluation_jobs` (unique
session), `interview_reports` (unique session+version). Retention: declined/expired/cancelled
sessions are minimised after 30 days; sessions, jobs and reports are deleted 18 months after
invitation.

## Endpoints

`POST/GET /interviews`, `GET /interviews/:id`, `POST /interviews/:id/{brief-access, accept,
decline, cancel, consent/withdraw, start, attach, heartbeat}` — see
[openapi.yaml](../api/openapi.yaml) (0.10.0). Every route returns 404 to non-participants and
carries server-computed `allowedActions`.

## Tests

`apps/server/test/interviews.lifecycle.test.ts` (19): invitation from a fresh batch and candidate
inbox; stale batch, gated candidate, duplicate pair, idempotent replay, 15-minute expiry; profile
revision revalidation; founder-only and 20/day limit; non-participants get 404; brief released
only after acknowledgement; required vs optional consents and ConsentRecord; no webcam item;
stale revision and `GATE_CHANGED`; no AI provider → 503; decline and 7-day expiry; founder cancel,
brief close cancels; consent withdrawal; resume missing / no text block start with actionable
messages; readiness report without camera; start with the fixed introduction, deadlines and
hidden fields absent, founder progress only; duplicate-window takeover; reconnect keeps
deadlines; 30-day minimisation. Also `interviews.integration.test.ts` (Mongo stores on a real
server), web `interviews.test.tsx` (inbox, acceptance flow, readiness) and the E2E journey.

## Limitations

- General brief access outside an invitation (`POST/DELETE /startups/:id/access`) is still not
  implemented; the confidentiality acknowledgement exists only within an invitation.
- Blocks: `NO_BLOCKS_YET` until the Safety phase.
- Rate-limit counters are per process (single instance).
