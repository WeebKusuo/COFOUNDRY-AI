import { describe, expect, it, vi } from 'vitest';
import type { BriefView, CompensationTerms, MatchView, SprintView } from '@cofoundry/shared';
import {
  buildCollaborationFixture,
  key,
  type CollaborationFixture,
} from './support/collaboration-fixture.js';
import type { TestClient } from './support/harness.js';

const DAY = 24 * 3600_000;

interface Ctx {
  f: CollaborationFixture;
  asha: TestClient;
  match: MatchView;
}

async function matchedCtx(): Promise<Ctx> {
  const f = await buildCollaborationFixture();
  const { candidate, match } = await f.matched();
  return { f, asha: candidate, match };
}

async function propose(c: Ctx, by: TestClient = c.f.founder, over = {}) {
  const res = await by.post(`/matches/${c.match.id}/sprints`, c.f.proposal(over), key());
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as SprintView;
}

const send = (by: TestClient, s: SprintView, extra = {}) =>
  by.post(`/sprints/${s.id}/send`, { expectedVersion: s.version, ...extra }, key());
const approve = (
  by: TestClient,
  s: { id: string; version: number; termsHash: string },
  extra = {},
) =>
  by.post(
    `/sprints/${s.id}/approve`,
    { expectedVersion: s.version, termsHash: s.termsHash, ...extra },
    key(),
  );

async function active(c: Ctx): Promise<SprintView> {
  const s = await propose(c);
  expect((await send(c.f.founder, s)).status).toBe(200);
  const res = await approve(c.asha, s);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as SprintView;
}

describe('Phase 12 — mutually approved trial sprint', () => {
  it('founder proposes, sends; candidate approves the identical version: sprint becomes active', async () => {
    const c = await matchedCtx();
    const s = await propose(c);
    expect(s).toMatchObject({
      status: 'proposed',
      version: 1,
      proposerRole: 'founder',
      approvals: [],
      allowedActions: ['edit', 'send', 'cancel'],
    });
    expect(s.termsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(s.terms.criteria.map((x) => x.id)).toHaveLength(2);
    expect(s.terms.ipPolicyVersion).toBe('creator-owned-v3.0');
    const forCandidate = (await c.asha.get(`/sprints/${s.id}`)).body.data as SprintView;
    expect(forCandidate.allowedActions).toEqual(['cancel']);
    // An unsent draft cannot be approved or rejected by the other participant.
    expect((await approve(c.asha, s)).status).toBe(409);
    expect(
      (await c.asha.post(`/sprints/${s.id}/reject`, { expectedVersion: 1, reason: 'No' }, key()))
        .status,
    ).toBe(409);

    const sent = (await send(c.f.founder, s)).body.data as SprintView;
    expect(sent).toMatchObject({
      status: 'awaiting_approval',
      approvals: [{ role: 'founder', version: 1 }],
    });
    // The founder cannot mark it mutually approved alone.
    expect((await approve(c.f.founder, sent)).status).toBe(403);
    const activeView = (await approve(c.asha, sent)).body.data as SprintView;
    expect(activeView.status).toBe('active');
    expect(activeView.startedAt).not.toBeNull();
    expect(activeView.approvals.map((a) => [a.role, a.version, a.termsHash])).toEqual([
      ['founder', 1, s.termsHash],
      ['candidate', 1, s.termsHash],
    ]);
    // Approving again returns the same state (no duplicate approval).
    const again = (await approve(c.asha, sent)).body.data as SprintView;
    expect(again.approvals).toHaveLength(2);
    const events = c.f.h.phase11.audit.events.map((e) => e.action);
    expect(events).toEqual(
      expect.arrayContaining(['sprint.created', 'sprint.sent', 'sprint.approved']),
    );
  });

  it('changing terms invalidates earlier approvals; stale version or hash is refused (SPR-01)', async () => {
    const c = await matchedCtx();
    const v1 = (await send(c.f.founder, await propose(c))).body.data as SprintView;
    const patched = await c.f.founder.patch(`/sprints/${v1.id}`, {
      expectedVersion: 1,
      changes: { expectedHours: 8 },
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const v2 = patched.body.data as SprintView;
    expect(v2).toMatchObject({ version: 2, status: 'proposed', approvals: [] });
    expect(v2.termsHash).not.toBe(v1.termsHash);
    expect(v2.history.map((h) => h.version)).toEqual([1, 2]);
    // Criteria text unchanged -> same ids; the review still refers to stable ids.
    expect(v2.terms.criteria.map((x) => x.id)).toEqual(v1.terms.criteria.map((x) => x.id));
    // Stale approval of version 1 (and a stale PATCH) -> 409 VERSION_CONFLICT.
    expect((await approve(c.asha, v1)).status).toBe(409);
    const stalePatch = await c.f.founder.patch(`/sprints/${v1.id}`, {
      expectedVersion: 1,
      changes: { title: 'x' },
    });
    expect(stalePatch.body.error.code).toBe('VERSION_CONFLICT');
    const v2sent = (await send(c.f.founder, v2)).body.data as SprintView;
    const wrongHash = await approve(c.asha, { ...v2sent, termsHash: v1.termsHash });
    expect(wrongHash.body.error.code).toBe('VERSION_CONFLICT');
    const ok = await approve(c.asha, v2sent);
    expect(ok.body.data).toMatchObject({ status: 'active', version: 2 });
  });

  it('rejects out-of-policy terms: hours, deadline window and lower pay (SPR-02)', async () => {
    const c = await matchedCtx();
    const bad = async (over: object) => {
      const res = await c.f.founder.post(
        `/matches/${c.match.id}/sprints`,
        c.f.proposal(over),
        key(),
      );
      expect(res.status, JSON.stringify(over)).toBe(422);
      return res.body.error.fieldErrors as Record<string, string[]>;
    };
    expect(Object.keys(await bad({ expectedHours: 11 }))).toContain('expectedHours');
    expect(Object.keys(await bad({ expectedHours: 0 }))).toContain('expectedHours');
    expect(Object.keys(await bad({ expectedHours: 5.5 }))).toContain('expectedHours');
    const past = new Date(c.f.clock.now.getTime() - 1000).toISOString();
    expect(Object.keys(await bad({ deadline: past }))).toContain('deadline');
    const tooFar = new Date(c.f.clock.now.getTime() + 15 * DAY).toISOString();
    expect(Object.keys(await bad({ deadline: tooFar }))).toContain('deadline');
    const lower = {
      compensation: {
        type: 'paid' as const,
        amountMinor: 100000,
        currency: 'INR' as const,
        payer: 'founder' as const,
        paymentDueDays: 7,
        methodNote: 'UPI',
      },
    };
    expect(Object.keys(await bad(lower))).toContain('compensation.amountMinor');
    const later = {
      compensation: { ...lower.compensation, amountMinor: 200000, paymentDueDays: 14 },
    };
    expect(Object.keys(await bad(later))).toContain('compensation.paymentDueDays');
    expect(Object.keys(await bad({ compensation: { type: 'unpaid' } }))).toContain(
      'compensation.type',
    );
    expect(Object.keys(await bad({ deliverables: [] }))).toContain('deliverables');
    expect(Object.keys(await bad({ scope: 'too short' }))).toContain('scope');
    // A higher amount is an allowed improvement.
    const better = await c.f.founder.post(
      `/matches/${c.match.id}/sprints`,
      c.f.proposal({
        compensation: {
          ...lower.compensation,
          amountMinor: 300000,
          methodNote: 'External bank/UPI transfer agreed directly.',
        },
      }),
      key(),
    );
    expect(better.status).toBe(201);
  });

  it('non-monetary terms need an explicit "no monetary payment" acknowledgement on send and approve', async () => {
    const c = await matchedCtx();
    // Make the match's brief terms unpaid so an unpaid sprint is not a downgrade.
    const m = (await c.f.h.phase11.matches.findById(c.match.id))!;
    await c.f.h.phase11.matches.replace(
      { ...m, termsSnapshot: { ...m.termsSnapshot, compensation: { type: 'unpaid' } } },
      m.rev,
    );
    const s = await propose(c, c.f.founder, { compensation: { type: 'unpaid' } });
    const noAck = await send(c.f.founder, s);
    expect(noAck.status).toBe(422);
    expect(noAck.body.error.fieldErrors.acknowledgeUnpaid).toBeTruthy();
    const sent = (await send(c.f.founder, s, { acknowledgeUnpaid: true })).body.data as SprintView;
    expect((await approve(c.asha, sent)).status).toBe(422);
    expect((await approve(c.asha, sent, { acknowledgeUnpaid: true })).body.data.status).toBe(
      'active',
    );
  });

  it('a candidate may propose; the founder approves; one sprint per match; active terms are immutable', async () => {
    const c = await matchedCtx();
    const s = await propose(c, c.asha);
    expect(s.proposerRole).toBe('candidate');
    expect(
      (await c.f.founder.post(`/matches/${c.match.id}/sprints`, c.f.proposal(), key())).status,
    ).toBe(409);
    const sent = (await send(c.asha, s)).body.data as SprintView;
    const act = (await approve(c.f.founder, sent)).body.data as SprintView;
    expect(act.status).toBe('active');
    const edit = await c.asha.patch(`/sprints/${s.id}`, {
      expectedVersion: act.version,
      changes: { title: 'New' },
    });
    expect(edit.status).toBe(409);
    expect((await c.f.founder.get(`/matches/${c.match.id}`)).body.data.sprint).toMatchObject({
      status: 'active',
    });
  });

  it('rejection is terminal and ends the match; terminal sprints cannot revive (SPR-04)', async () => {
    const c = await matchedCtx();
    const sent = (await send(c.f.founder, await propose(c))).body.data as SprintView;
    const rej = await c.asha.post(
      `/sprints/${sent.id}/reject`,
      { expectedVersion: 1, reason: 'Scope too big' },
      key(),
    );
    expect(rej.body.data).toMatchObject({
      status: 'rejected',
      terminalReason: 'rejected',
      allowedActions: [],
    });
    expect((await c.asha.get(`/matches/${c.match.id}`)).body.data).toMatchObject({
      status: 'ended',
      endReason: 'sprint_rejected',
    });
    expect((await send(c.f.founder, sent)).status).toBe(409);
    expect(
      (await c.f.founder.post(`/sprints/${sent.id}/cancel`, { reason: 'x' }, key())).status,
    ).toBe(409);
    expect(
      (await c.f.founder.post(`/matches/${c.match.id}/sprints`, c.f.proposal(), key())).status,
    ).toBe(409);
  });

  it('either participant cancels; the match ends; history is kept', async () => {
    const c = await matchedCtx();
    const s = await active(c);
    const res = await c.f.founder.post(
      `/sprints/${s.id}/cancel`,
      { reason: 'Priorities changed' },
      key(),
    );
    expect(res.body.data).toMatchObject({
      status: 'cancelled',
      terminalReason: 'participant_cancelled',
      terminalNote: 'Priorities changed',
    });
    expect(res.body.data.approvals).toHaveLength(2); // the agreement record remains
    expect((await c.asha.get(`/matches/${c.match.id}`)).body.data.endReason).toBe(
      'sprint_cancelled',
    );
  });

  it('a proposal whose deadline passes before activation is cancelled and the match ends', async () => {
    const c = await matchedCtx();
    const s = (await send(c.f.founder, await propose(c))).body.data as SprintView;
    c.f.later(8 * DAY);
    const res = await approve(c.asha, s);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EXPIRED');
    expect((await c.asha.get(`/sprints/${s.id}`)).body.data).toMatchObject({
      status: 'cancelled',
      terminalReason: 'proposal_expired',
    });
    expect((await c.asha.get(`/matches/${c.match.id}`)).body.data.status).toBe('ended');
  });

  it('only participants can read or act on a sprint', async () => {
    const c = await matchedCtx();
    const s = await propose(c);
    const dev = await c.f.as('dev');
    expect((await dev.get(`/sprints/${s.id}`)).status).toBe(404);
    expect((await approve(dev, s)).status).toBe(404);
    expect((await dev.post(`/matches/${c.match.id}/sprints`, c.f.proposal(), key())).status).toBe(
      404,
    );
  });
});

describe('Phase 13 — submission, review and completion', () => {
  it('candidate submits a URL, founder reviews each criterion, both acknowledge: completed', async () => {
    const c = await matchedCtx();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const s = await active(c);
    const sub = await c.asha.post(
      `/sprints/${s.id}/submit`,
      {
        url: 'https://github.com/asha/payouts-webhook/pull/1',
        note: 'See README',
        sharePermissionAcknowledged: true,
      },
      key(),
    );
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.data).toMatchObject({
      status: 'submitted',
      submission: { url: 'https://github.com/asha/payouts-webhook/pull/1', note: 'See README' },
    });
    expect(fetchSpy).not.toHaveBeenCalled(); // the link is never fetched (AUTH-07)
    fetchSpy.mockRestore();
    const [c1, c2] = s.terms.criteria;
    const review = await c.f.founder.post(
      `/sprints/${s.id}/review`,
      {
        criteriaResults: [
          { criterionId: c1!.id, outcome: 'met', reason: 'Duplicate test passes' },
          { criterionId: c2!.id, outcome: 'partially_met', reason: 'Retry case missing' },
        ],
        summary: 'Good work overall.',
      },
      key(),
    );
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    expect(review.body.data.review).toMatchObject({ version: 1, overallOutcome: 'partially_met' });
    const ack1 = await c.asha.post(
      `/sprints/${s.id}/acknowledge`,
      { reviewVersion: 1, disagreementNote: 'The retry test is in tests/retry.test.ts' },
      key(),
    );
    expect(ack1.body.data).toMatchObject({ status: 'reviewed' });
    // A duplicate acknowledgement does not add a second record.
    const dup = await c.asha.post(`/sprints/${s.id}/acknowledge`, { reviewVersion: 1 }, key());
    expect(dup.body.data.acknowledgements).toHaveLength(1);
    const ack2 = await c.f.founder.post(
      `/sprints/${s.id}/acknowledge`,
      { reviewVersion: 1 },
      key(),
    );
    expect(ack2.body.data).toMatchObject({
      status: 'completed',
      terminalReason: 'completed',
      allowedActions: [],
    });
    expect((await c.asha.get(`/matches/${c.match.id}`)).body.data.status).toBe('completed');
    // Completed trials count on the founder's brief preview (counts completed, not "successful").
    const brief = (await c.asha.get(`/startups/${c.f.briefId}`)).body.data as BriefView;
    expect(brief.preview.founder.completedSprintCount).toBe(1);
  });

  it('validates the deliverable link safely', async () => {
    const c = await matchedCtx();
    const s = await active(c);
    for (const url of [
      'http://example.com/x',
      'https://user:pass@example.com/x',
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://example.com/x#frag',
      'https://example.com:8443/x',
      'javascript:alert(1)',
      'https://printer.local/x',
    ]) {
      const res = await c.asha.post(
        `/sprints/${s.id}/submit`,
        { url, sharePermissionAcknowledged: true },
        key(),
      );
      expect(res.status, url).toBe(422);
    }
    const noAttest = await c.asha.post(
      `/sprints/${s.id}/submit`,
      { url: 'https://example.com/a' },
      key(),
    );
    expect(noAttest.status).toBe(422);
  });

  it('only the contributor submits once; only the founder reviews every criterion once (SPR-03)', async () => {
    const c = await matchedCtx();
    const s = await active(c);
    const url = { url: 'https://example.com/work', sharePermissionAcknowledged: true };
    expect((await c.f.founder.post(`/sprints/${s.id}/submit`, url, key())).status).toBe(403);
    expect((await c.asha.post(`/sprints/${s.id}/submit`, url, key())).status).toBe(200);
    // Same link again is a harmless repeat; a different link is refused (no resubmission).
    expect((await c.asha.post(`/sprints/${s.id}/submit`, url, key())).body.data.status).toBe(
      'submitted',
    );
    const other = await c.asha.post(
      `/sprints/${s.id}/submit`,
      { ...url, url: 'https://example.com/v2' },
      key(),
    );
    expect(other.status).toBe(409);
    const [c1, c2] = s.terms.criteria;
    const rev = (results: unknown[]) =>
      c.f.founder.post(`/sprints/${s.id}/review`, { criteriaResults: results }, key());
    expect(
      (
        await c.asha.post(
          `/sprints/${s.id}/review`,
          { criteriaResults: [{ criterionId: c1!.id, outcome: 'met', reason: 'x' }] },
          key(),
        )
      ).status,
    ).toBe(403);
    expect((await rev([{ criterionId: c1!.id, outcome: 'met', reason: 'ok' }])).status).toBe(422);
    expect(
      (
        await rev([
          { criterionId: c1!.id, outcome: 'met', reason: 'ok' },
          { criterionId: c1!.id, outcome: 'met', reason: 'ok' },
        ])
      ).status,
    ).toBe(422);
    expect(
      (
        await rev([
          { criterionId: c1!.id, outcome: 'met', reason: 'ok' },
          { criterionId: 'c_unknown', outcome: 'met', reason: 'ok' },
        ])
      ).status,
    ).toBe(422);
    const all = [
      { criterionId: c1!.id, outcome: 'met', reason: 'ok' },
      { criterionId: c2!.id, outcome: 'met', reason: 'ok' },
    ];
    expect((await rev(all)).body.data.review.overallOutcome).toBe('met');
    expect((await rev(all)).status).toBe(409); // one immutable review
    expect(
      (await c.asha.post(`/sprints/${s.id}/acknowledge`, { reviewVersion: 2 }, key())).status,
    ).toBe(409);
  });

  it('a missed deadline cancels the sprint and ends the match; late submissions are refused (SPR-05)', async () => {
    const c = await matchedCtx();
    const s = await active(c);
    c.f.later(7 * DAY + 1);
    const late = await c.asha.post(
      `/sprints/${s.id}/submit`,
      { url: 'https://example.com/w', sharePermissionAcknowledged: true },
      key(),
    );
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('EXPIRED');
    expect((await c.asha.get(`/sprints/${s.id}`)).body.data).toMatchObject({
      status: 'cancelled',
      terminalReason: 'deadline_missed',
    });
    expect((await c.asha.get(`/matches/${c.match.id}`)).body.data.status).toBe('ended');
  });

  it('review and acknowledgement windows time out durably and keep the history', async () => {
    const c = await matchedCtx();
    const s = await active(c);
    await c.asha.post(
      `/sprints/${s.id}/submit`,
      { url: 'https://example.com/w', sharePermissionAcknowledged: true },
      key(),
    );
    c.f.later(7 * DAY);
    expect(await c.f.h.sprints.sweep()).toBe(1);
    const timedOut = (await c.asha.get(`/sprints/${s.id}`)).body.data as SprintView;
    expect(timedOut).toMatchObject({ status: 'cancelled', terminalReason: 'review_timeout' });
    expect(timedOut.submission?.url).toBe('https://example.com/w');

    const d = await matchedCtx();
    const t = await active(d);
    await d.asha.post(
      `/sprints/${t.id}/submit`,
      { url: 'https://example.com/w', sharePermissionAcknowledged: true },
      key(),
    );
    const ids = t.terms.criteria.map((x) => ({
      criterionId: x.id,
      outcome: 'not_met',
      reason: 'Missing',
    }));
    await d.f.founder.post(`/sprints/${t.id}/review`, { criteriaResults: ids }, key());
    await d.asha.post(`/sprints/${t.id}/acknowledge`, { reviewVersion: 1 }, key());
    d.f.later(7 * DAY);
    expect(await d.f.h.sprints.sweep()).toBe(1);
    const ackTimeout = (await d.f.founder.get(`/sprints/${t.id}`)).body.data as SprintView;
    expect(ackTimeout).toMatchObject({
      status: 'cancelled',
      terminalReason: 'acknowledgement_timeout',
    });
    expect(ackTimeout.review?.overallOutcome).toBe('not_met');
    expect(ackTimeout.acknowledgements).toHaveLength(1);
  });

  it('concurrent submit and cancel resolve to one consistent committed state', async () => {
    const c = await matchedCtx();
    const s = await active(c);
    const [sub, can] = await Promise.all([
      c.asha.post(
        `/sprints/${s.id}/submit`,
        { url: 'https://example.com/w', sharePermissionAcknowledged: true },
        key(),
      ),
      c.f.founder.post(`/sprints/${s.id}/cancel`, { reason: 'Stop' }, key()),
    ]);
    const final = (await c.f.founder.get(`/sprints/${s.id}`)).body.data as SprintView;
    // Cancellation is always allowed until completion, so it wins either way.
    expect(can.status).toBe(200);
    expect(final.status).toBe('cancelled');
    if (sub.status === 200) expect(final.submission).not.toBeNull();
    else expect(final.submission).toBeNull();
  });
});

describe('Phase 12 — review regressions', () => {
  it('paid terms keep the brief’s payment method; unpaid cannot become credit/reference', async () => {
    const c = await matchedCtx();
    const base = c.f.proposal().compensation as Extract<CompensationTerms, { type: 'paid' }>;
    const res = await c.f.founder.post(
      `/matches/${c.match.id}/sprints`,
      c.f.proposal({ compensation: { ...base, methodNote: 'Paid at founder discretion.' } }),
      key(),
    );
    expect(res.status).toBe(422);
    expect(res.body.error.fieldErrors['compensation.methodNote']).toBeTruthy();
    const m = (await c.f.h.phase11.matches.findById(c.match.id))!;
    await c.f.h.phase11.matches.replace(
      { ...m, termsSnapshot: { ...m.termsSnapshot, compensation: { type: 'unpaid' } } },
      m.rev,
    );
    const credit = await c.f.founder.post(
      `/matches/${c.match.id}/sprints`,
      c.f.proposal({
        compensation: {
          type: 'credit_reference',
          benefitDescription: 'A public reference on LinkedIn.',
        },
      }),
      key(),
    );
    expect(credit.status).toBe(422);
    expect(credit.body.error.fieldErrors['compensation.type']).toBeTruthy();
  });
});
