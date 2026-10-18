import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  CaseContextView,
  CaseReporterView,
  CaseSummaryView,
  MatchRequestView,
  MatchView,
  SprintView,
  TermsSnapshot,
} from '@cofoundry/shared';
import { renderRoute } from '../../test/render';
import { demoUser, installFakeApi } from '../../test/fake-api';

const candidate = demoUser(['candidate'], { displayName: 'Asha' });
const founder = demoUser(['founder']);
const moderator = demoUser(['moderator'], { displayName: 'Mod' });
const RID = '1'.repeat(24);
const MID = '2'.repeat(24);
const SID = '3'.repeat(24);
const IID = '4'.repeat(24);

const terms: TermsSnapshot = {
  briefId: '5'.repeat(24),
  briefVersion: 1,
  title: 'PayPilot payment reconciliation API',
  hoursRequiredPerWeek: 8,
  commitmentMonths: 3,
  compensation: {
    type: 'paid',
    amountMinor: 200000,
    currency: 'INR',
    payer: 'founder',
    paymentDueDays: 7,
    methodNote: 'External bank/UPI transfer agreed directly.',
  },
  ipPolicyVersion: 'creator-owned-v3.0',
  trialCapHours: 10,
};
const people = {
  founder: { userId: '6'.repeat(24), displayName: 'Rohan', demoAccount: true },
  candidate: { userId: '7'.repeat(24), displayName: 'Asha', demoAccount: true },
};

function request(over: Partial<MatchRequestView> = {}): MatchRequestView {
  return {
    id: RID,
    status: 'pending',
    viewerRole: 'candidate',
    briefId: terms.briefId,
    briefTitle: terms.title,
    interviewId: IID,
    reportVersion: 1,
    message: 'Your reconciliation answers were great.',
    terms,
    ...people,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    respondedAt: null,
    responseReason: null,
    withdrawReason: null,
    matchId: null,
    report: {
      interviewId: IID,
      reportVersion: 1,
      overallScore: 78.5,
      evidenceLevel: 'strong',
      openCorrections: 1,
      quarantined: false,
    },
    timeline: [{ at: new Date().toISOString(), event: 'Request sent', actor: 'founder' }],
    allowedActions: ['accept', 'decline'],
    unavailable: false,
    serverNow: new Date().toISOString(),
    ...over,
  };
}

const sprintTerms = (over: Partial<SprintView['terms']> = {}): SprintView['terms'] => ({
  title: 'Webhook ingestion endpoint',
  scope: 'Build one REST endpoint that ingests payout webhooks idempotently, with tests.',
  deliverables: ['Endpoint', 'Tests'],
  criteria: [
    { id: 'c_1', text: 'Duplicates stored once' },
    { id: 'c_2', text: 'Retry tests exist' },
  ],
  expectedHours: 6,
  deadline: new Date(Date.now() + 7 * 86400_000).toISOString(),
  compensation: terms.compensation,
  ipPolicyVersion: 'creator-owned-v3.0',
  ...over,
});

function sprint(over: Partial<SprintView> = {}): SprintView {
  const t = sprintTerms();
  return {
    id: SID,
    matchId: MID,
    status: 'awaiting_approval',
    viewerRole: 'candidate',
    proposerRole: 'founder',
    version: 2,
    termsHash: 'b'.repeat(64),
    terms: t,
    minimumCompensation: terms.compensation,
    approvals: [
      {
        role: 'founder',
        version: 2,
        termsHash: 'b'.repeat(64),
        approvedAt: new Date().toISOString(),
      },
    ],
    history: [
      {
        version: 1,
        terms: sprintTerms({ expectedHours: 4 }),
        termsHash: 'a'.repeat(64),
        changedAt: new Date().toISOString(),
        changedBy: 'founder',
      },
      {
        version: 2,
        terms: t,
        termsHash: 'b'.repeat(64),
        changedAt: new Date().toISOString(),
        changedBy: 'founder',
      },
    ],
    createdAt: new Date().toISOString(),
    sentAt: new Date().toISOString(),
    startedAt: null,
    submittedAt: null,
    reviewedAt: null,
    completedAt: null,
    cancelledAt: null,
    submission: null,
    review: null,
    acknowledgements: [],
    terminalReason: null,
    terminalNote: null,
    reviewDueAt: null,
    acknowledgementDueAt: null,
    timeline: [],
    allowedActions: ['approve', 'reject', 'cancel'],
    ...people,
    serverNow: new Date().toISOString(),
    ...over,
  };
}

function match(over: Partial<MatchView> = {}): MatchView {
  return {
    id: MID,
    requestId: RID,
    status: 'active',
    viewerRole: 'candidate',
    briefId: terms.briefId,
    briefTitle: terms.title,
    terms,
    ...people,
    interviewId: IID,
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    endNote: null,
    sprint: {
      id: SID,
      status: 'awaiting_approval',
      version: 2,
      title: 'Webhook',
      deadline: sprintTerms().deadline,
    },
    allowedActions: ['end'],
    unavailable: false,
    serverNow: new Date().toISOString(),
    ...over,
  };
}

const ok = (data: unknown, status = 200) => ({ status, body: { data, requestId: 'r' } });
const list = (data: unknown[]) => ({
  status: 200,
  body: { data, nextCursor: null, requestId: 'r' },
});

function recorder(
  handler: (m: string, p: string, b: unknown) => { status: number; body?: unknown } | undefined,
) {
  const calls: Array<{
    method: string;
    path: string;
    body: unknown;
    headers: Record<string, string>;
  }> = [];
  return {
    calls,
    routes: (method: string, path: string, body: unknown, headers: Record<string, string>) => {
      calls.push({ method, path, body, headers });
      return handler(method, path, body);
    },
  };
}

describe('Phase 11 — requests and matches UI', () => {
  it('candidate inbox has separate tabs; accepting creates the match', async () => {
    let current = request();
    const a = recorder((m, p) => {
      if (p === '/interviews') return list([]);
      if (p === '/match-requests' && m === 'GET') return list([current]);
      if (p === `/match-requests/${RID}` && m === 'GET') return ok(current);
      if (p === `/match-requests/${RID}/accept`) {
        current = request({ status: 'accepted', matchId: MID, allowedActions: ['view_match'] });
        return ok({ request: current, match: match() });
      }
      return undefined;
    });
    installFakeApi({ user: candidate, routes: a.routes });
    renderRoute('/candidate/inbox?tab=requests');
    const tab = await screen.findByRole('tab', { name: /Collaboration requests/ });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Interview invitations/ })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('link', { name: terms.title }));
    expect(await screen.findByText('Your reconciliation answers were great.')).toBeInTheDocument();
    expect(screen.getByText(/1 correction request\(s\) are open/)).toBeInTheDocument();
    expect(screen.getByText(/You retain ownership/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Accept and match' }));
    expect(await screen.findByRole('link', { name: 'Open the match' })).toHaveAttribute(
      'href',
      `/candidate/matches/${MID}`,
    );
    const call = a.calls.find((c) => c.path.endsWith('/accept'))!;
    expect(call.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('shows the unavailable state without any actions after a block', async () => {
    const r = request({
      status: 'withdrawn',
      withdrawReason: 'unavailable',
      unavailable: true,
      allowedActions: [],
    });
    installFakeApi({
      user: candidate,
      routes: (_m, p) => (p === `/match-requests/${RID}` ? ok(r) : undefined),
    });
    renderRoute(`/candidate/requests/${RID}`);
    expect(
      await screen.findByText('This collaboration is no longer available'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept and match' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Block/ })).not.toBeInTheDocument();
  });

  it('a participant ends a match with a reason', async () => {
    const m = match({ sprint: null, allowedActions: ['end', 'propose_sprint'] });
    const a = recorder((meth, p) => {
      if (p === `/matches/${MID}` && meth === 'GET') return ok(m);
      if (p === `/matches/${MID}/end`) return ok({ ...m, status: 'ended', allowedActions: [] });
      return undefined;
    });
    installFakeApi({ user: candidate, routes: a.routes });
    renderRoute(`/candidate/matches/${MID}`);
    expect(
      await screen.findByRole('button', { name: 'Propose a trial sprint' }),
    ).toBeInTheDocument();
    const end = screen.getByRole('button', { name: 'End match' });
    expect(end).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Reason \(shared/), 'Timing does not work');
    await userEvent.click(end);
    expect(a.calls.find((c) => c.path.endsWith('/end'))!.body).toEqual({
      reason: 'Timing does not work',
    });
  });
});

describe('Phase 12-13 — sprint UI', () => {
  it('approval requires explicit agreement to the exact version and hash; shows what changed', async () => {
    const a = recorder((m, p) => {
      if (p === `/matches/${MID}`) return ok(match());
      if (p === `/sprints/${SID}` && m === 'GET') return ok(sprint());
      if (p === `/sprints/${SID}/approve`)
        return ok(sprint({ status: 'active', allowedActions: ['submit', 'cancel'] }));
      return undefined;
    });
    installFakeApi({ user: candidate, routes: a.routes });
    renderRoute(`/candidate/matches/${MID}`);
    const diff = await screen.findByRole('table', { name: 'Changed terms' });
    expect(within(diff).getByText('Expected hours')).toBeInTheDocument();
    expect(within(diff).getByText('4 hours')).toBeInTheDocument();
    expect(within(diff).getByText('6 hours')).toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Approve and start the sprint' });
    expect(approve).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/I approve version 2 of these terms/));
    await userEvent.click(approve);
    expect(a.calls.find((c) => c.path.endsWith('/approve'))!.body).toEqual({
      expectedVersion: 2,
      termsHash: 'b'.repeat(64),
    });
  });

  it('non-monetary terms need the "no monetary payment" acknowledgement too', async () => {
    const unpaid = sprint({
      terms: sprintTerms({ compensation: { type: 'unpaid' } }),
      history: [],
    });
    const a = recorder((m, p) => {
      if (p === `/matches/${MID}`) return ok(match());
      if (p === `/sprints/${SID}` && m === 'GET') return ok(unpaid);
      if (p === `/sprints/${SID}/approve`) return ok(unpaid);
      return undefined;
    });
    installFakeApi({ user: candidate, routes: a.routes });
    renderRoute(`/candidate/matches/${MID}`);
    await userEvent.click(await screen.findByLabelText(/I approve version 2/));
    const approve = screen.getByRole('button', { name: 'Approve and start the sprint' });
    expect(approve).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/No monetary payment promised/));
    await userEvent.click(approve);
    expect(a.calls.find((c) => c.path.endsWith('/approve'))!.body).toMatchObject({
      acknowledgeUnpaid: true,
    });
  });

  it('submission validates the link before sending and requires the attestation', async () => {
    const s = sprint({ status: 'active', allowedActions: ['submit', 'cancel'], history: [] });
    const a = recorder((m, p) => {
      if (p === `/matches/${MID}`) return ok(match());
      if (p === `/sprints/${SID}` && m === 'GET') return ok(s);
      if (p === `/sprints/${SID}/submit`) return ok({ ...s, status: 'submitted' });
      return undefined;
    });
    installFakeApi({ user: candidate, routes: a.routes });
    renderRoute(`/candidate/matches/${MID}`);
    const url = await screen.findByLabelText(/Link to your work/);
    await userEvent.type(url, 'http://example.com/x');
    expect(screen.getByText('Only https:// links are accepted.')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Submit work' });
    expect(submit).toBeDisabled();
    await userEvent.clear(url);
    await userEvent.type(url, 'https://github.com/asha/pr/1');
    expect(submit).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/The founder may view this link/));
    await userEvent.click(submit);
    expect(a.calls.find((c) => c.path.endsWith('/submit'))!.body).toEqual({
      url: 'https://github.com/asha/pr/1',
      sharePermissionAcknowledged: true,
    });
  });

  it('the founder reviews every agreed criterion with evidence', async () => {
    const s = sprint({
      viewerRole: 'founder',
      status: 'submitted',
      allowedActions: ['review', 'cancel'],
      history: [],
      submission: {
        url: 'https://github.com/asha/pr/1',
        note: 'See README',
        sharePermissionAcknowledged: true,
        submittedAt: new Date().toISOString(),
      },
      reviewDueAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    });
    const a = recorder((m, p) => {
      if (p === `/matches/${MID}`) return ok(match({ viewerRole: 'founder' }));
      if (p === `/sprints/${SID}` && m === 'GET') return ok(s);
      if (p === `/sprints/${SID}/review`) return ok(s);
      return undefined;
    });
    installFakeApi({ user: founder, routes: a.routes });
    renderRoute(`/founder/matches/${MID}`);
    expect(await screen.findByText('Review due')).toBeInTheDocument();
    const record = screen.getByRole('button', { name: 'Record review' });
    const groups = screen
      .getAllByRole('group')
      .filter((g) => /Criterion \d/.test(g.textContent ?? ''));
    expect(groups).toHaveLength(2);
    for (const [i, g] of groups.entries()) {
      await userEvent.selectOptions(
        within(g).getByLabelText('Outcome'),
        i === 0 ? 'met' : 'partially_met',
      );
      if (i === 0) expect(record).toBeDisabled();
      await userEvent.type(within(g).getByLabelText('Evidence and feedback'), `Evidence ${i + 1}`);
    }
    await userEvent.click(record);
    expect(a.calls.find((c) => c.path.endsWith('/review'))!.body).toEqual({
      criteriaResults: [
        { criterionId: 'c_1', outcome: 'met', reason: 'Evidence 1' },
        { criterionId: 'c_2', outcome: 'partially_met', reason: 'Evidence 2' },
      ],
    });
  });

  it('a completed sprint shows the summary and no actions', async () => {
    const s = sprint({
      status: 'completed',
      terminalReason: 'completed',
      allowedActions: [],
      history: [],
      completedAt: new Date().toISOString(),
      review: {
        version: 1,
        criteriaResults: [
          { criterionId: 'c_1', outcome: 'met', reason: 'Yes' },
          { criterionId: 'c_2', outcome: 'met', reason: 'Yes' },
        ],
        overallOutcome: 'met',
        summary: '',
        reviewedAt: new Date().toISOString(),
      },
      acknowledgements: [
        { role: 'founder', reviewVersion: 1, disagreementNote: '', at: new Date().toISOString() },
        {
          role: 'candidate',
          reviewVersion: 1,
          disagreementNote: 'Fine',
          at: new Date().toISOString(),
        },
      ],
    });
    installFakeApi({
      user: candidate,
      routes: (_m, p) =>
        p === `/matches/${MID}`
          ? ok(match({ status: 'completed', allowedActions: [] }))
          : p === `/sprints/${SID}`
            ? ok(s)
            : undefined,
    });
    renderRoute(`/candidate/matches/${MID}`);
    expect(await screen.findByText('Completed trial', { selector: 'p' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Cancel sprint|Acknowledge|Record review/ }),
    ).not.toBeInTheDocument();
  });
});

describe('Phase 14 — safety and moderation UI', () => {
  it('safety page lists own blocks and cases, labelling claims as unverified', async () => {
    const cases: CaseReporterView[] = [
      {
        id: '8'.repeat(24),
        kind: 'report',
        category: 'sprint_dispute',
        targetType: 'sprint',
        targetId: SID,
        text: 'Asked for work outside scope.',
        status: 'open',
        verified: false,
        resolutionText: null,
        displayCorrection: null,
        hold: null,
        openedAt: new Date().toISOString(),
        resolvedAt: null,
      },
    ];
    const a = recorder((m, p) => {
      if (p === '/blocks' && m === 'GET')
        return ok([
          {
            targetUserId: people.founder.userId,
            displayName: 'Rohan',
            createdAt: new Date().toISOString(),
          },
        ]);
      if (p === '/cases') return list(cases);
      if (p === `/blocks/${people.founder.userId}`) return { status: 204 };
      return undefined;
    });
    installFakeApi({ user: candidate, routes: a.routes });
    renderRoute('/candidate/account');
    expect(await screen.findByText('Your claim (not a verified finding)')).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Unblock Rohan' }));
    expect(
      a.calls.some((c) => c.method === 'DELETE' && c.path === `/blocks/${people.founder.userId}`),
    ).toBe(true);
  });

  it('moderator claims a case, reads evidence and records an audited decision', async () => {
    const CID = '9'.repeat(24);
    let assigned = false;
    const summary = (): CaseSummaryView => ({
      id: CID,
      kind: 'correction',
      category: 'assessment_error',
      targetType: 'report',
      status: assigned ? 'in_review' : 'open',
      assignedToMe: assigned,
      assigned,
      openedAt: new Date().toISOString(),
      resolvedAt: null,
    });
    const ctx = (): CaseContextView => ({
      case: {
        ...summary(),
        text: 'The AI ignored my retry answer.',
        reporterUserId: people.candidate.userId,
        targetUserId: null,
        targetId: IID,
        resolutionText: null,
        displayCorrection: null,
        hold: null,
        notes: [],
        quarantinedReport: false,
        suspendedTarget: false,
      },
      participants: [
        {
          userId: people.candidate.userId,
          displayName: 'Asha',
          role: 'reporter',
          status: 'active',
        },
      ],
      evidence: [{ label: 'Q1 evaluated (75)', value: 'Walk me through…\nAnswer: …' }],
      relatedOpenCases: 0,
    });
    const a = recorder((m, p) => {
      if (p === '/admin/cases') return list([summary()]);
      if (p === `/admin/cases/${CID}` && m === 'GET') return ok(summary());
      if (p === `/admin/cases/${CID}/claim`) {
        assigned = true;
        return ok(summary());
      }
      if (p === `/admin/cases/${CID}/context`)
        return assigned
          ? ok(ctx())
          : {
              status: 403,
              body: { error: { code: 'FORBIDDEN', message: 'Claim first.' }, requestId: 'r' },
            };
      if (p === `/admin/cases/${CID}/resolve`)
        return ok({ ...ctx(), case: { ...ctx().case, status: 'resolved' } });
      return undefined;
    });
    installFakeApi({ user: moderator, routes: a.routes });
    renderRoute(`/moderator/cases/${CID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Claim case' }));
    expect(await screen.findByText('The AI ignored my retry answer.')).toBeInTheDocument();
    expect(screen.getByText('Q1 evaluated (75)')).toBeInTheDocument();
    expect(
      a.calls.filter((c) => c.path.endsWith('/context') && c.method === 'GET').length,
    ).toBeGreaterThan(0);
    await userEvent.type(screen.getByLabelText(/Resolution \(the reporter sees this\)/), 'Upheld.');
    await userEvent.type(screen.getByLabelText(/Display correction/), 'Q2 mentions retries.');
    await userEvent.click(screen.getByRole('button', { name: 'Record decision' }));
    const resolve = a.calls.find((c) => c.path.endsWith('/resolve'))!;
    expect(resolve.body).toEqual({
      decision: 'resolved',
      resolutionText: 'Upheld.',
      displayCorrection: 'Q2 mentions retries.',
      quarantineReport: false,
      suspendTarget: false,
    });
    expect(resolve.headers['Idempotency-Key']).toBeTruthy();
  });
});
