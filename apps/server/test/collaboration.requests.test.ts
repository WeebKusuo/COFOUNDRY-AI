import { describe, expect, it } from 'vitest';
import type { MatchRequestView, MatchView } from '@cofoundry/shared';
import {
  buildCollaborationFixture,
  key,
  type CollaborationFixture,
} from './support/collaboration-fixture.js';
import { addTestUser } from './support/harness.js';

const DAY = 24 * 3600_000;

async function withReport(): Promise<{ f: CollaborationFixture; interviewId: string }> {
  const f = await buildCollaborationFixture();
  return { f, interviewId: await f.evaluatedInterview('asha') };
}

describe('Phase 11 — collaboration request and match creation', () => {
  it('founder reviews the report, sends a request, candidate accepts: exactly one match both can read', async () => {
    const { f, interviewId } = await withReport();
    // The founder can read the completed report before deciding.
    const report = await f.founder.get(`/interviews/${interviewId}/report`);
    expect(report.body.data.state).toBe('ready');

    const sent = await f.sendRequest(
      interviewId,
      'asha',
      'Your reconciliation answers were great.',
    );
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const req = sent.body.data;
    expect(req).toMatchObject({
      status: 'pending',
      viewerRole: 'founder',
      interviewId,
      allowedActions: ['withdraw'],
      terms: {
        briefId: f.briefId,
        compensation: { type: 'paid', amountMinor: 200000 },
        ipPolicyVersion: 'creator-owned-v3.0',
        trialCapHours: 10,
      },
    });
    expect(req.report.reportVersion).toBe(1);
    expect(Date.parse(req.expiresAt) - Date.parse(req.createdAt)).toBe(7 * DAY);
    expect(JSON.stringify(req)).not.toMatch(/@demo|email/i); // no contact details

    const asha = await f.as('asha');
    const inbox = await asha.get('/match-requests?box=inbox');
    expect(inbox.status).toBe(200);
    expect(inbox.body.data.map((r: MatchRequestView) => r.id)).toEqual([req.id]);
    const detail = (await asha.get(`/match-requests/${req.id}`)).body.data as MatchRequestView;
    expect(detail).toMatchObject({
      viewerRole: 'candidate',
      allowedActions: ['accept', 'decline'],
    });
    expect(detail.message).toBe('Your reconciliation answers were great.');

    const accepted = await asha.post(`/match-requests/${req.id}/accept`, {}, key());
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const { request, match } = accepted.body.data as {
      request: MatchRequestView;
      match: MatchView;
    };
    expect(request).toMatchObject({
      status: 'accepted',
      matchId: match.id,
      allowedActions: ['view_match'],
    });
    expect(match).toMatchObject({
      status: 'active',
      requestId: req.id,
      briefId: f.briefId,
      allowedActions: ['end', 'propose_sprint'],
    });
    expect(match.terms).toEqual(req.terms);
    expect(f.h.phase11.matches.t.rows.size).toBe(1);

    for (const [client, role] of [
      [f.founder, 'founder'],
      [asha, 'candidate'],
    ] as const) {
      const m = await client.get(`/matches/${match.id}`);
      expect(m.status).toBe(200);
      expect(m.body.data.viewerRole).toBe(role);
      const list = await client.get(`/matches?role=${role}`);
      expect(list.body.data.map((x: MatchView) => x.id)).toEqual([match.id]);
    }
    const actions = f.h.phase11.audit.events.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['match_request.created', 'match_request.accepted']),
    );
    expect(JSON.stringify(f.h.phase11.audit.events)).not.toContain('reconciliation answers');
  });

  it('enforces ownership, participation and role on every route', async () => {
    const { f, interviewId } = await withReport();
    const req = (await f.sendRequest(interviewId, 'asha')).body.data;
    f.users.rival = await addTestUser(f.ids, 'rival@demo.test', ['founder'], {
      cohortId: 'demo-v3.0',
    });
    const rival = await f.as('rival');
    // Another founder: cannot create for this brief/interview, read or act on the request.
    const probe = await rival.post(
      '/match-requests',
      { briefId: f.briefId, interviewId, candidateUserId: f.users.asha!.id, message: '' },
      key(),
    );
    expect(probe.status).toBe(404);
    expect((await rival.get(`/match-requests/${req.id}`)).status).toBe(404);
    expect((await rival.post(`/match-requests/${req.id}/withdraw`, {}, key())).status).toBe(404);
    // Another candidate cannot see or accept it.
    const dev = await f.as('dev');
    expect((await dev.get(`/match-requests/${req.id}`)).status).toBe(404);
    expect((await dev.post(`/match-requests/${req.id}/accept`, {}, key())).status).toBe(404);
    // Participants with the wrong role get 403.
    expect((await f.founder.post(`/match-requests/${req.id}/accept`, {}, key())).status).toBe(403);
    const asha = await f.as('asha');
    expect((await asha.post(`/match-requests/${req.id}/withdraw`, {}, key())).status).toBe(403);
    expect((await asha.get('/match-requests?box=sent')).status).toBe(403);
    expect((await f.founder.get('/match-requests?box=inbox')).status).toBe(403);
    // The rival's own box is empty: no other founder's relationships leak.
    expect((await rival.get('/match-requests?box=sent')).body.data).toEqual([]);
  });

  it('requires a completed report for the same brief and candidate, consent and current gates', async () => {
    const f = await buildCollaborationFixture();
    // An interview that is not evaluated yet cannot support a request.
    const pending = (await f.invite(f.founder, 'dev')).id;
    const early = await f.sendRequest(pending, 'dev');
    expect(early.status).toBe(409);
    expect(early.body.error!.code).toBe('INVALID_STATE');
    const interviewId = await f.evaluatedInterview('asha');
    // Interview of another candidate -> 404 (never reveals the other pair).
    expect((await f.sendRequest(interviewId, 'dev')).status).toBe(404);
    // Changed gates: the candidate's hours dropped below the brief's mandatory minimum.
    const p = f.pstore.candidates.get(f.users.asha!.id)!;
    f.pstore.candidates.set(p.userId, { ...p, availableHoursPerWeek: 2 });
    const gated = await f.sendRequest(interviewId, 'asha');
    expect(gated.body.error!.code).toBe('GATE_CHANGED');
    f.pstore.candidates.set(p.userId, p);
    // Consent withdrawn -> unavailable.
    const asha = await f.as('asha');
    await asha.post(`/interviews/${interviewId}/consent/withdraw`, {});
    const withdrawn = await f.sendRequest(interviewId, 'asha');
    expect(withdrawn.status).toBe(409);
    expect(withdrawn.body.error!.code).toBe('INVALID_STATE');
  });

  it('one request per brief and candidate for the brief lifetime; idempotent replays', async () => {
    const { f, interviewId } = await withReport();
    const k = key();
    const body = {
      briefId: f.briefId,
      interviewId,
      candidateUserId: f.users.asha!.id,
      message: 'Hi',
    };
    const first = await f.founder.post('/match-requests', body, k);
    const replay = await f.founder.post('/match-requests', body, k);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    const conflict = await f.founder.post('/match-requests', { ...body, message: 'Other' }, k);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const dup = await f.founder.post('/match-requests', body, key());
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_PAIR');
    // After a decline the pair cannot get another request (REQ-02).
    const asha = await f.as('asha');
    const declined = await asha.post(
      `/match-requests/${first.body.data.id}/decline`,
      { reason: 'Busy' },
      key(),
    );
    expect(declined.body.data).toMatchObject({ status: 'declined', responseReason: 'Busy' });
    expect((await f.founder.post('/match-requests', body, key())).body.error.code).toBe(
      'DUPLICATE_PAIR',
    );
    expect(f.h.phase11.requests.t.rows.size).toBe(1);
  });

  it('two simultaneous creates leave one request; two simultaneous accepts create exactly one match', async () => {
    const { f, interviewId } = await withReport();
    const body = {
      briefId: f.briefId,
      interviewId,
      candidateUserId: f.users.asha!.id,
      message: '',
    };
    const [a, b] = await Promise.all([
      f.founder.post('/match-requests', body, key()),
      f.founder.post('/match-requests', body, key()),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(f.h.phase11.requests.t.rows.size).toBe(1);
    const id = (a.status === 201 ? a : b).body.data.id as string;
    const asha = await f.as('asha');
    const asha2 = await f.as('asha');
    const [x, y] = await Promise.all([
      asha.post(`/match-requests/${id}/accept`, {}, key()),
      asha2.post(`/match-requests/${id}/accept`, {}, key()),
    ]);
    expect(x.status).toBe(200);
    expect(y.status).toBe(200);
    expect(x.body.data.match.id).toBe(y.body.data.match.id);
    expect(f.h.phase11.matches.t.rows.size).toBe(1);
  });

  it('a failed match insert rolls the acceptance back (no accepted request without a match)', async () => {
    const { f, interviewId } = await withReport();
    const id = (await f.sendRequest(interviewId, 'asha')).body.data.id;
    const store = f.h.phase11.matches;
    const original = store.insert.bind(store);
    store.insert = async () => {
      throw new Error('simulated write failure');
    };
    const asha = await f.as('asha');
    const res = await asha.post(`/match-requests/${id}/accept`, {}, key());
    expect(res.status).toBe(500);
    store.insert = original;
    expect(f.h.phase11.tx.rollbacks).toBeGreaterThan(0);
    expect((await f.h.phase11.requests.findById(id))!.status).toBe('pending');
    expect(store.t.rows.size).toBe(0);
    // A retry succeeds normally.
    expect((await asha.post(`/match-requests/${id}/accept`, {}, key())).status).toBe(200);
  });

  it('requests expire after 7 days in handlers and in the sweep; expired requests cannot be accepted', async () => {
    const { f, interviewId } = await withReport();
    const id = (await f.sendRequest(interviewId, 'asha')).body.data.id;
    f.later(7 * DAY);
    // The sweep has not run yet; the handler enforces expiry synchronously (REQ-03).
    const asha = await f.as('asha');
    const res = await asha.post(`/match-requests/${id}/accept`, {}, key());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EXPIRED');
    expect((await asha.get(`/match-requests/${id}`)).body.data).toMatchObject({
      status: 'expired',
      allowedActions: [],
    });
    expect(f.h.phase11.matches.t.rows.size).toBe(0);
    // A second request for the pair is still refused.
    expect((await f.sendRequest(interviewId, 'asha')).body.error!.code).toBe('DUPLICATE_PAIR');
  });

  it('the 60-second sweep expires pending requests durably', async () => {
    const { f, interviewId } = await withReport();
    const id = (await f.sendRequest(interviewId, 'asha')).body.data.id;
    f.later(7 * DAY + 1);
    expect((await f.h.collaboration.sweep()).expired).toBe(1);
    expect((await f.h.phase11.requests.findById(id))!.status).toBe('expired');
  });

  it('founder withdraws while pending; closing the brief withdraws pending requests', async () => {
    const { f, interviewId } = await withReport();
    const id = (await f.sendRequest(interviewId, 'asha')).body.data.id;
    const w = await f.founder.post(
      `/match-requests/${id}/withdraw`,
      { reason: 'Role filled' },
      key(),
    );
    expect(w.body.data).toMatchObject({ status: 'withdrawn', withdrawReason: 'founder_withdrew' });
    // Repeating the same transition returns the same state; accepting is refused.
    expect(
      (await f.founder.post(`/match-requests/${id}/withdraw`, {}, key())).body.data.status,
    ).toBe('withdrawn');
    const asha = await f.as('asha');
    expect((await asha.post(`/match-requests/${id}/accept`, {}, key())).status).toBe(409);

    // Brief close path on a fresh fixture.
    const g = await withReport();
    const rid = (await g.f.sendRequest(g.interviewId, 'asha')).body.data.id;
    const close = await g.f.founder.post(
      `/startups/${g.f.briefId}/close`,
      { reason: 'Paused' },
      key(),
    );
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    expect((await g.f.h.phase11.requests.findById(rid))!).toMatchObject({
      status: 'withdrawn',
      withdrawReason: 'brief_closed',
    });
  });

  it('a daily founder limit of 20 requests applies', async () => {
    const { f, interviewId } = await withReport();
    const seed = (await f.sendRequest(interviewId, 'asha')).body.data;
    const base = (await f.h.phase11.requests.findById(seed.id))!;
    for (let i = 0; i < 20; i += 1) {
      const id = `${'f'.repeat(22)}${String(i).padStart(2, '0')}`;
      await f.h.phase11.requests.insert({ ...base, id, briefId: id, rev: 0 });
    }
    f.h.phase11.requests.t.rows.delete(seed.id);
    const res = await f.sendRequest(interviewId, 'asha');
    expect(res.status).toBe(429);
  });
});

describe('Phase 11 — match lifecycle', () => {
  it('either participant ends an active match; ended matches accept no sprint', async () => {
    const f = await buildCollaborationFixture();
    const { candidate, match } = await f.matched();
    const ended = await candidate.post(
      `/matches/${match.id}/end`,
      { reason: 'Timing does not work' },
      key(),
    );
    expect(ended.status).toBe(200);
    expect(ended.body.data).toMatchObject({
      status: 'ended',
      endReason: 'participant_ended',
      endNote: 'Timing does not work',
      allowedActions: [],
    });
    const founderView = (await f.founder.get(`/matches/${match.id}`)).body.data as MatchView;
    expect(founderView.status).toBe('ended');
    const sprint = await f.founder.post(`/matches/${match.id}/sprints`, f.proposal(), key());
    expect(sprint.status).toBe(409);
    // Ending an already-ended match returns it unchanged.
    const again = await f.founder.post(`/matches/${match.id}/end`, { reason: 'x' }, key());
    expect(again.body.data).toMatchObject({ status: 'ended', endNote: 'Timing does not work' });
  });

  it('an active match with no sprint ends after 30 days (inactivity)', async () => {
    const f = await buildCollaborationFixture();
    const { match } = await f.matched();
    f.later(31 * DAY);
    expect((await f.h.collaboration.sweep()).dormant).toBe(1);
    expect((await f.founder.get(`/matches/${match.id}`)).body.data).toMatchObject({
      status: 'ended',
      endReason: 'inactivity',
    });
  });

  it('outsiders cannot read a match', async () => {
    const f = await buildCollaborationFixture();
    const { match } = await f.matched();
    const dev = await f.as('dev');
    expect((await dev.get(`/matches/${match.id}`)).status).toBe(404);
    expect((await dev.post(`/matches/${match.id}/end`, { reason: 'x' }, key())).status).toBe(404);
  });
});

describe('Phase 11 — review regressions', () => {
  it('a brief closed during acceptance never leaves an active match on it', async () => {
    const { f, interviewId } = await withReport();
    const id = (await f.sendRequest(interviewId, 'asha')).body.data.id;
    const close = async () => {
      const b = (await f.briefStore.findById(f.briefId))!;
      f.briefStore.records.set(b.id, { ...b, status: 'closed', closedAt: f.clock.now });
    };
    // Closed after the pre-checks but before the transaction re-reads the brief: refused.
    const guards = f.h.phase11.guards;
    const touch = guards.touch.bind(guards);
    guards.touch = async (a, b) => {
      await close();
      return touch(a, b);
    };
    const asha = await f.as('asha');
    expect((await asha.post(`/match-requests/${id}/accept`, {}, key())).status).toBe(409);
    guards.touch = touch;
    expect([...f.h.phase11.matches.t.rows.values()].filter((m) => m.status === 'active')).toEqual(
      [],
    );

    // Closed right after the match insert: the new match is ended (reason brief_closed).
    const g = await withReport();
    const rid = (await g.f.sendRequest(g.interviewId, 'asha')).body.data.id;
    const store = g.f.h.phase11.matches;
    const insert = store.insert.bind(store);
    store.insert = async (m) => {
      const res = await insert(m);
      const b = (await g.f.briefStore.findById(g.f.briefId))!;
      g.f.briefStore.records.set(b.id, { ...b, status: 'closed', closedAt: g.f.clock.now });
      return res;
    };
    const asha2 = await g.f.as('asha');
    const res = await asha2.post(`/match-requests/${rid}/accept`, {}, key());
    store.insert = insert;
    expect(res.body.data.match).toMatchObject({ status: 'ended', endReason: 'brief_closed' });
  });

  it('the sweep repairs an accepted request whose match was lost', async () => {
    const { f, interviewId } = await withReport();
    const id = (await f.sendRequest(interviewId, 'asha')).body.data.id;
    const asha = await f.as('asha');
    await asha.post(`/match-requests/${id}/accept`, {}, key());
    f.h.phase11.matches.t.rows.clear(); // simulate a crash between the two writes
    expect((await f.h.collaboration.sweep()).repaired).toBe(1);
    expect(await f.h.phase11.matches.findByRequest(id)).not.toBeNull();
  });

  it('the founder finds the request for one interview directly', async () => {
    const { f, interviewId } = await withReport();
    const id = (await f.sendRequest(interviewId, 'asha')).body.data.id;
    const res = await f.founder.get(`/match-requests?box=sent&interviewId=${interviewId}&limit=1`);
    expect(res.body.data.map((r: MatchRequestView) => r.id)).toEqual([id]);
    const none = await f.founder.get(`/match-requests?box=sent&interviewId=${'a'.repeat(24)}`);
    expect(none.body.data).toEqual([]);
  });
});
