import { describe, expect, it } from 'vitest';
import type {
  CaseContextView,
  CaseReporterView,
  CaseSummaryView,
  InterviewReportView,
  InterviewSessionView,
  MatchRequestView,
  RecommendationSearchResponse,
  SprintView,
} from '@cofoundry/shared';
import {
  buildCollaborationFixture,
  key,
  type CollaborationFixture,
} from './support/collaboration-fixture.js';
import { addTestUser, type TestClient } from './support/harness.js';

const DAY = 24 * 3600_000;

const ids = (r: RecommendationSearchResponse) =>
  [...r.recommendations, ...r.provisional, ...r.nearMatches].map((e) => e.candidateUserId);

async function activeSprint(f: CollaborationFixture) {
  const { candidate, match, interviewId, request } = await f.matched();
  const s = (await f.founder.post(`/matches/${match.id}/sprints`, f.proposal(), key())).body
    .data as SprintView;
  await f.founder.post(`/sprints/${s.id}/send`, { expectedVersion: 1 }, key());
  const act = await candidate.post(
    `/sprints/${s.id}/approve`,
    { expectedVersion: 1, termsHash: s.termsHash },
    key(),
  );
  expect(act.body.data.status).toBe('active');
  return { asha: candidate, match, sprint: act.body.data as SprintView, interviewId, request };
}

describe('Phase 14 — blocking across feature boundaries', () => {
  it('a block ends the match and sprint, cuts report access and prevents new interaction', async () => {
    const f = await buildCollaborationFixture();
    const { asha, match, sprint, interviewId } = await activeSprint(f);
    const res = await asha.post('/blocks', { targetUserId: f.users.founder!.id }, key());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      targetUserId: f.users.founder!.id,
      displayName: f.users.founder!.displayName,
    });

    const m = (await f.founder.get(`/matches/${match.id}`)).body.data;
    expect(m).toMatchObject({
      status: 'ended',
      endReason: 'unavailable',
      unavailable: true,
      allowedActions: [],
    });
    const s = (await f.founder.get(`/sprints/${sprint.id}`)).body.data as SprintView;
    expect(s).toMatchObject({
      status: 'cancelled',
      terminalReason: 'unavailable',
      allowedActions: [],
    });
    // Both keep the minimal historical agreement record (terms, approvals).
    expect(s.approvals).toHaveLength(2);
    // Nothing tells the founder that a block (rather than anything else) happened.
    expect(JSON.stringify(m)).not.toMatch(/blocked/i);
    expect(JSON.stringify(s)).not.toMatch(/blocked/i);
    // The founder's access to the candidate's assessment ends; the candidate keeps theirs.
    const rep = await f.founder.get(`/interviews/${interviewId}/report`);
    expect(rep.status).toBe(403);
    expect(rep.body.error.message).toBe('This collaboration is no longer available.');
    expect((await f.founder.get(`/interviews/${interviewId}`)).body.data.turns).toEqual([]);
    expect((await asha.get(`/interviews/${interviewId}/report`)).status).toBe(200);
    // New interactions are refused: no new sprint, and the candidate is gone from discovery.
    expect((await f.founder.post(`/matches/${match.id}/sprints`, f.proposal(), key())).status).toBe(
      409,
    );
    const search = (await f.founder.post(`/startups/${f.briefId}/recommendations`, {}, key())).body
      .data as RecommendationSearchResponse;
    expect(ids(search)).not.toContain(f.users.asha!.id);
    expect(f.h.phase11.audit.events.map((e) => e.action)).toContain('block.created');
  });

  it('pending requests are withdrawn and pre-submit interviews cancelled by a block', async () => {
    const f = await buildCollaborationFixture();
    const interviewId = await f.evaluatedInterview('asha');
    const req = (await f.sendRequest(interviewId, 'asha')).body.data;
    const pendingInterview = (await f.invite(f.founder, 'dev')).id;
    expect(
      (await f.founder.post('/blocks', { targetUserId: f.users.asha!.id }, key())).status,
    ).toBe(201);
    expect((await f.founder.post('/blocks', { targetUserId: f.users.dev!.id }, key())).status).toBe(
      201,
    );
    const asha = await f.as('asha');
    const view = (await asha.get(`/match-requests/${req.id}`)).body.data as MatchRequestView;
    expect(view).toMatchObject({
      status: 'withdrawn',
      withdrawReason: 'unavailable',
      unavailable: true,
      allowedActions: [],
    });
    expect((await asha.post(`/match-requests/${req.id}/accept`, {}, key())).status).toBe(409);
    const dev = await f.as('dev');
    const iv = (await dev.get(`/interviews/${pendingInterview}`)).body.data as InterviewSessionView;
    expect(iv).toMatchObject({ status: 'cancelled', cancellationReason: 'unavailable' });
    // Inviting a blocked candidate fails at the invitation boundary.
    const batch = (await f.founder.post(`/startups/${f.briefId}/recommendations`, {}, key())).body
      .data;
    expect(ids(batch)).not.toContain(f.users.dev!.id);
  });

  it('blocks need legitimate visibility; no self-block; list shows only own blocks', async () => {
    const f = await buildCollaborationFixture();
    const asha = await f.as('asha');
    // Asha has no relationship with Mira: 404, never confirming the account exists.
    expect((await asha.post('/blocks', { targetUserId: f.users.mira!.id }, key())).status).toBe(
      404,
    );
    expect((await asha.post('/blocks', { targetUserId: 'a'.repeat(24) }, key())).status).toBe(404);
    expect((await asha.post('/blocks', { targetUserId: f.users.asha!.id }, key())).status).toBe(
      400,
    );
    // The founder can block a candidate shown in their latest results.
    await f.search(f.founder);
    expect(
      (await f.founder.post('/blocks', { targetUserId: f.users.isha!.id }, key())).status,
    ).toBe(201);
    expect(
      (await f.founder.get('/blocks')).body.data.map(
        (b: { targetUserId: string }) => b.targetUserId,
      ),
    ).toEqual([f.users.isha!.id]);
    const isha = await f.as('isha');
    expect((await isha.get('/blocks')).body.data).toEqual([]); // the target never sees it
  });

  it('unblocking removes only the caller’s block and never revives cancelled relationships', async () => {
    const f = await buildCollaborationFixture();
    const { asha, match } = await activeSprint(f);
    await asha.post('/blocks', { targetUserId: f.users.founder!.id }, key());
    expect((await f.founder.delete(`/blocks/${f.users.asha!.id}`)).status).toBe(404); // not theirs
    expect((await asha.delete(`/blocks/${f.users.founder!.id}`)).status).toBe(204);
    expect((await asha.get('/blocks')).body.data).toEqual([]);
    expect((await asha.get(`/matches/${match.id}`)).body.data).toMatchObject({
      status: 'ended',
      endReason: 'unavailable',
    });
    expect(f.h.phase11.audit.events.map((e) => e.action)).toContain('block.removed');
  });

  it('a concurrent block and accept never leave an active post-block match (SAFE-01)', async () => {
    const f = await buildCollaborationFixture();
    const interviewId = await f.evaluatedInterview('asha');
    const req = (await f.sendRequest(interviewId, 'asha')).body.data;
    const asha = await f.as('asha');
    const [acc, blk] = await Promise.all([
      asha.post(`/match-requests/${req.id}/accept`, {}, key()),
      f.founder.post('/blocks', { targetUserId: f.users.asha!.id }, key()),
    ]);
    expect(blk.status).toBe(201);
    const active = [...f.h.phase11.matches.t.rows.values()].filter((m) => m.status === 'active');
    expect(active).toEqual([]);
    if (acc.status === 200)
      expect((await f.h.phase11.matches.findById(acc.body.data.match.id))!.endReason).toBe(
        'blocked',
      );
    else expect(acc.status).toBe(409);
  });
});

describe('Phase 14 — reports and corrections', () => {
  it('a participant reports misconduct; duplicates link; only the reporter sees the case', async () => {
    const f = await buildCollaborationFixture();
    const { asha, sprint } = await activeSprint(f);
    const body = {
      targetType: 'sprint',
      targetId: sprint.id,
      category: 'sprint_dispute',
      text: 'The founder asked for work outside the agreed scope.',
    };
    const first = await asha.post('/reports', body, key());
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const c = first.body.data as CaseReporterView;
    expect(c).toMatchObject({
      kind: 'report',
      status: 'open',
      verified: false,
      category: 'sprint_dispute',
    });
    const dup = await asha.post(
      '/reports',
      { ...body, text: 'Same problem again, still happening.' },
      key(),
    );
    expect(dup.status).toBe(200);
    expect(dup.body.data).toMatchObject({ id: c.id, linked: true });
    expect((await asha.get('/cases')).body.data.map((x: CaseReporterView) => x.id)).toEqual([c.id]);
    // The reported founder can neither list nor open it; the reporter's identity is not exposed.
    expect((await f.founder.get('/cases')).body.data).toEqual([]);
    expect((await f.founder.get(`/cases/${c.id}`)).status).toBe(404);
    // An unrelated user cannot report this sprint.
    const mira = await f.as('mira');
    expect((await mira.post('/reports', body, key())).status).toBe(404);
    expect((await asha.post('/reports', { ...body, text: 'short' }, key())).status).toBe(422);
  });

  it('at most 10 cases per user per day', async () => {
    const f = await buildCollaborationFixture();
    const { asha, sprint } = await activeSprint(f);
    const store = f.h.phase11.cases;
    const now = f.clock.now;
    for (let i = 0; i < 10; i += 1) {
      await store.insert({
        id: `${'e'.repeat(22)}${String(i).padStart(2, '0')}`,
        rev: 0,
        kind: 'report',
        category: 'other',
        reporterUserId: f.users.asha!.id,
        targetUserId: null,
        targetType: 'user',
        targetId: `${'d'.repeat(22)}${String(i).padStart(2, '0')}`,
        text: 'x'.repeat(20),
        status: 'resolved',
        assignedModeratorId: null,
        resolutionText: null,
        correctionOverlay: null,
        quarantinedReport: false,
        suspendedTarget: false,
        hold: null,
        notes: [],
        openedAt: now,
        resolvedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
    const res = await asha.post(
      '/reports',
      {
        targetType: 'sprint',
        targetId: sprint.id,
        category: 'other',
        text: 'Something else went wrong.',
      },
      key(),
    );
    expect(res.status).toBe(429);
  });

  it('corrections: own report or profile only; open corrections are shown to both report participants', async () => {
    const f = await buildCollaborationFixture();
    const interviewId = await f.evaluatedInterview('asha');
    const asha = await f.as('asha');
    const text = 'The transcript of question 2 misheard "idempotency" as "identity".';
    expect(
      (
        await f.founder.post(
          '/corrections',
          { targetType: 'report', targetId: interviewId, text },
          key(),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await asha.post(
          '/corrections',
          { targetType: 'profile', targetId: f.users.dev!.id, text },
          key(),
        )
      ).status,
    ).toBe(404);
    const res = await asha.post(
      '/corrections',
      { targetType: 'report', targetId: interviewId, text },
      key(),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      kind: 'correction',
      category: 'assessment_error',
      status: 'open',
    });
    const own = await asha.post(
      '/corrections',
      { targetType: 'profile', targetId: f.users.asha!.id, text },
      key(),
    );
    expect(own.status).toBe(201);
    for (const c of [asha, f.founder]) {
      const r = (await c.get(`/interviews/${interviewId}/report`)).body.data
        .report as InterviewReportView;
      expect(r.openCorrections).toBe(1);
    }
    // The request preview shows it too, without blocking the founder's decision.
    const req = (await f.sendRequest(interviewId, 'asha')).body.data as MatchRequestView;
    expect(req.report.openCorrections).toBe(1);
  });
});

describe('Phase 14 — moderation', () => {
  async function caseOnReport() {
    const f = await buildCollaborationFixture();
    const interviewId = await f.evaluatedInterview('asha');
    const asha = await f.as('asha');
    const opened = await asha.post(
      '/corrections',
      {
        targetType: 'report',
        targetId: interviewId,
        text: 'The AI said I never mentioned retries, but I did in Q2.',
      },
      key(),
    );
    const mod = await f.as('moderator');
    return { f, interviewId, asha, mod, caseId: opened.body.data.id as string };
  }

  it('moderation routes are moderator-only; evidence needs an assigned case; access is audited', async () => {
    const { f, caseId, asha, mod } = await caseOnReport();
    expect((await asha.get('/admin/cases')).status).toBe(403);
    expect((await f.founder.get(`/admin/cases/${caseId}/context`)).status).toBe(403);
    const list = await mod.get('/admin/cases?status=open');
    expect(list.status).toBe(200);
    const summary = list.body.data[0] as CaseSummaryView;
    expect(summary).toMatchObject({ id: caseId, status: 'open', assigned: false });
    expect(JSON.stringify(list.body.data)).not.toContain('retries'); // no content in the list
    expect((await mod.get(`/admin/cases/${caseId}/context`)).status).toBe(403); // not claimed
    const claim = await mod.post(`/admin/cases/${caseId}/claim`, {});
    expect(claim.body.data).toMatchObject({ status: 'in_review', assignedToMe: true });
    f.users.mod2 = await addTestUser(f.ids, 'mod2@demo.test', ['moderator'], {
      cohortId: 'demo-v3.0',
    });
    const mod2 = await f.as('mod2');
    expect((await mod2.post(`/admin/cases/${caseId}/claim`, {})).status).toBe(409);
    expect((await mod2.get(`/admin/cases/${caseId}/context`)).status).toBe(403);
    const ctx = (await mod.get(`/admin/cases/${caseId}/context`)).body.data as CaseContextView;
    expect(ctx.case.text).toContain('retries');
    expect(ctx.evidence.some((e) => e.label.startsWith('Q1'))).toBe(true);
    expect(ctx.participants.map((p) => p.userId)).toEqual(
      expect.arrayContaining([f.users.asha!.id, f.users.founder!.id]),
    );
    const actions = f.h.phase11.audit.events.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['case.opened', 'case.claimed', 'case.context_read']),
    );
    // The moderator has no interview routes (cannot read or change answers or scores there).
    expect((await mod.get(`/interviews/${ctx.case.targetId}`)).status).toBe(403);
  });

  it('a display correction overlays the report; answers and numeric scores are unchanged (SAFE-02)', async () => {
    const { f, caseId, interviewId, asha, mod } = await caseOnReport();
    const before = (await asha.get(`/interviews/${interviewId}/report`)).body.data
      .report as InterviewReportView;
    await mod.post(`/admin/cases/${caseId}/claim`, {});
    await mod.post(`/admin/cases/${caseId}/notes`, { text: 'Checked the transcript.' });
    const resolved = await mod.post(
      `/admin/cases/${caseId}/resolve`,
      {
        decision: 'resolved',
        resolutionText: 'The answer to Q2 does mention retries.',
        displayCorrection: 'Q2: the candidate did describe retries with exponential backoff.',
        quarantineReport: false,
        suspendTarget: false,
      },
      key(),
    );
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect((resolved.body.data as CaseContextView).case.notes).toHaveLength(1);
    for (const c of [asha, f.founder]) {
      const r = (await c.get(`/interviews/${interviewId}/report`)).body.data
        .report as InterviewReportView;
      expect(r.corrections).toEqual([
        expect.objectContaining({
          text: 'Q2: the candidate did describe retries with exponential backoff.',
          by: 'CoFoundry moderator',
        }),
      ]);
      expect(r.overall).toEqual(before.overall);
      expect(r.questions.map((q) => [q.answer?.text, q.score])).toEqual(
        before.questions.map((q) => [q.answer?.text, q.score]),
      );
    }
    const mine = (await asha.get(`/cases/${caseId}`)).body.data as CaseReporterView;
    expect(mine).toMatchObject({
      status: 'resolved',
      resolutionText: 'The answer to Q2 does mention retries.',
    });
    expect(JSON.stringify(mine)).not.toContain('Checked the transcript'); // internal notes stay internal
  });

  it('quarantine blocks new requests and hides AI narrative; dismissed cases cannot sanction', async () => {
    const { f, caseId, interviewId, asha, mod } = await caseOnReport();
    await mod.post(`/admin/cases/${caseId}/claim`, {});
    const bad = await mod.post(
      `/admin/cases/${caseId}/resolve`,
      { decision: 'dismissed', resolutionText: 'No', quarantineReport: true, suspendTarget: false },
      key(),
    );
    expect(bad.status).toBe(422);
    await mod.post(
      `/admin/cases/${caseId}/resolve`,
      {
        decision: 'resolved',
        resolutionText: 'Disputed narrative.',
        quarantineReport: true,
        suspendTarget: false,
      },
      key(),
    );
    const r = (await asha.get(`/interviews/${interviewId}/report`)).body.data
      .report as InterviewReportView;
    expect(r.quarantine).not.toBeNull();
    expect(r.strengths).toEqual([]);
    expect(r.questions.every((q) => q.strengths.length === 0)).toBe(true);
    expect(r.questions[0]!.answer?.text).toBeTruthy(); // source answers remain
    const req = await f.sendRequest(interviewId, 'asha');
    expect(req.status).toBe(409);
    expect(f.h.phase11.audit.events.map((e) => e.action)).toContain('case.resolved');
  });

  it('suspending a report target revokes sessions and ends their relationships', async () => {
    const f = await buildCollaborationFixture();
    const { asha, match, sprint } = await activeSprint(f);
    const opened = await asha.post(
      '/reports',
      {
        targetType: 'user',
        targetId: f.users.founder!.id,
        category: 'harassment_or_abuse',
        text: 'Abusive messages after the review.',
      },
      key(),
    );
    const mod = await f.as('moderator');
    const id = opened.body.data.id;
    await mod.post(`/admin/cases/${id}/claim`, {});
    const res = await mod.post(
      `/admin/cases/${id}/resolve`,
      {
        decision: 'resolved',
        resolutionText: 'Confirmed by evidence.',
        quarantineReport: false,
        suspendTarget: true,
      },
      key(),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await f.ids.findUserById(f.users.founder!.id))!.status).toBe('suspended');
    expect((await f.founder.get('/matches?role=founder')).status).toBe(401);
    expect((await asha.get(`/matches/${match.id}`)).body.data).toMatchObject({
      status: 'ended',
      endReason: 'unavailable',
    });
    expect((await asha.get(`/sprints/${sprint.id}`)).body.data.terminalReason).toBe('unavailable');
    expect(f.h.phase11.audit.events.map((e) => e.action)).toContain('user.suspended');
  });

  it('an assigned case holds the related interview from retention until resolved', async () => {
    const { f, caseId, interviewId, mod } = await caseOnReport();
    const claimed = await mod.post(`/admin/cases/${caseId}/claim`, {});
    expect(claimed.status).toBe(200);
    const asha = await f.as('asha');
    const mine = (await asha.get(`/cases/${caseId}`)).body.data as CaseReporterView;
    expect(mine.hold).toMatchObject({ scope: 'report' });
    f.later(19 * 30 * DAY);
    await f.h.interviews.purgeRetention();
    expect(await f.h.interviewStore.findById(interviewId)).not.toBeNull();
    // Moderator sessions expired with the clock jump; sign in again and resolve.
    const mod2 = await f.as('moderator');
    await mod2.post(
      `/admin/cases/${caseId}/resolve`,
      {
        decision: 'dismissed',
        resolutionText: 'Not upheld.',
        quarantineReport: false,
        suspendTarget: false,
      },
      key(),
    );
    await f.h.interviews.purgeRetention();
    expect(await f.h.interviewStore.findById(interviewId)).toBeNull();
  });
});

export type { TestClient };

describe('Phase 14 — review regressions', () => {
  it('a block hides the current public profile in both directions', async () => {
    const f = await buildCollaborationFixture();
    const { asha } = await activeSprint(f);
    expect((await f.founder.get(`/profiles/${f.users.asha!.id}`)).status).toBe(200);
    await asha.post('/blocks', { targetUserId: f.users.founder!.id }, key());
    expect((await f.founder.get(`/profiles/${f.users.asha!.id}`)).status).toBe(404);
    expect((await asha.get(`/profiles/${f.users.asha!.id}`)).status).toBe(200); // own profile
  });

  it('withdrawn consent hides assessment facts from the founder and refuses acceptance', async () => {
    const f = await buildCollaborationFixture();
    const interviewId = await f.evaluatedInterview('asha');
    const req = (await f.sendRequest(interviewId, 'asha')).body.data as MatchRequestView;
    expect(req.report.overallScore).not.toBeNull();
    const asha = await f.as('asha');
    await asha.post(`/interviews/${interviewId}/consent/withdraw`, {});
    const fv = (await f.founder.get(`/match-requests/${req.id}`)).body.data as MatchRequestView;
    expect(fv.report).toMatchObject({ overallScore: null, evidenceLevel: null });
    expect(fv.allowedActions).toEqual([]);
    const acc = await asha.post(`/match-requests/${req.id}/accept`, {}, key());
    expect(acc.status).toBe(409);
    expect(f.h.phase11.matches.t.rows.size).toBe(0);
  });

  it('a live block is enforced even if the post-block interview hook never ran', async () => {
    const f = await buildCollaborationFixture();
    const interviewId = await f.evaluatedInterview('asha');
    // A live interview for Dev, then block rows written without the cascade (crash simulation).
    const devInterview = (await f.invite(f.founder, 'dev')).id;
    const dev = await f.as('dev');
    await f.acknowledge(dev, devInterview);
    await f.accept(dev, devInterview);
    await f.seedResume('dev');
    const { clientId, view } = await f.start(dev, devInterview);
    const at = f.clock.now;
    await f.h.phase11.blocks.insert({
      id: 'b'.repeat(24),
      blockerUserId: f.users.asha!.id,
      blockedUserId: f.users.founder!.id,
      createdAt: at,
    });
    await f.h.phase11.blocks.insert({
      id: 'c'.repeat(24),
      blockerUserId: f.users.dev!.id,
      blockedUserId: f.users.founder!.id,
      createdAt: at,
    });
    expect((await f.founder.get(`/interviews/${interviewId}/report`)).status).toBe(403);
    expect((await f.founder.get(`/interviews/${interviewId}`)).body.data.turns).toEqual([]);
    const answer = await dev.post(
      `/interviews/${devInterview}/turns/${view.currentTurnIndex}/answer`,
      { text: 'An answer after the block was created.', inputMode: 'typed' },
      { 'X-Interview-Client': clientId },
    );
    expect(answer.status).toBe(409);
  });

  it('a moderator cannot claim or decide a case they are involved in', async () => {
    const f = await buildCollaborationFixture();
    const { asha } = await activeSprint(f);
    const opened = await asha.post(
      '/reports',
      {
        targetType: 'user',
        targetId: f.users.founder!.id,
        category: 'other',
        text: 'Something inappropriate happened.',
      },
      key(),
    );
    // The founder account also holds the moderator role.
    const u = f.users.founder!;
    f.ids.users.set(u.id, { ...u, roles: ['founder', 'moderator'] });
    const both = await f.as('founder');
    const claim = await both.post(`/admin/cases/${opened.body.data.id}/claim`, {});
    expect(claim.status).toBe(403);
    expect((await both.get(`/admin/cases/${opened.body.data.id}/context`)).status).toBe(403);
    // An uninvolved moderator can, and can read the case summary directly.
    const mod = await f.as('moderator');
    expect((await mod.get(`/admin/cases/${opened.body.data.id}`)).body.data.status).toBe('open');
    expect((await mod.post(`/admin/cases/${opened.body.data.id}/claim`, {})).status).toBe(200);
  });
});
