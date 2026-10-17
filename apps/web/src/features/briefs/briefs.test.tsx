import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  emptyBriefDraft,
  toCompensationTerms,
  type BriefDraftFields,
  type BriefPreview,
  type StartupBriefData,
} from '@cofoundry/shared';
import { renderRoute } from '../../test/render';
import { demoUser, installFakeApi } from '../../test/fake-api';
import { changedFields, fieldsFromForm, formFromBrief, paiseFromRupees } from './draft';

const LONG = 'A sentence that is clearly longer than fifty characters for publishing.';
const ID = 'b'.repeat(24);

function brief(overrides: Partial<StartupBriefData> = {}): StartupBriefData {
  return {
    id: ID,
    status: 'draft',
    version: 0,
    roleKey: 'backend-node-v1',
    opportunityType: 'contributor',
    workMode: 'remote',
    ipPolicyVersion: 'creator-owned-v3.0',
    ...emptyBriefDraft('Webhook worker'),
    publishedAt: null,
    closedAt: null,
    closeReason: null,
    clonedFromId: null,
    createdAt: '2026-10-17T10:00:00.000Z',
    updatedAt: '2026-10-17T10:00:00.000Z',
    ...overrides,
  };
}

const completeFields: Partial<BriefDraftFields> = {
  teaser: LONG,
  problem: `Problem. ${LONG}`,
  solution: `Solution. ${LONG}`,
  industryTags: ['fintech'],
  missionTags: ['reliability'],
  teamSkills: [{ skillId: 'nodejs', level: 2 }],
  requiredSkills: [{ skillId: 'nodejs', level: 4, importance: 2, mandatory: false }],
  hoursRequiredPerWeek: 8,
  commitmentMonths: 3,
  compensation: {
    type: 'paid',
    amountMinor: 200_000,
    paymentDueDays: 7,
    methodNote: 'UPI',
    benefitDescription: '',
  },
};

function previewOf(b: StartupBriefData): BriefPreview {
  return {
    id: b.id,
    status: b.status,
    version: b.version,
    title: b.title,
    teaser: b.teaser,
    roleKey: b.roleKey,
    opportunityType: b.opportunityType,
    workMode: b.workMode,
    requiredSkills: b.requiredSkills,
    hoursRequiredPerWeek: b.hoursRequiredPerWeek,
    commitmentMonths: b.commitmentMonths,
    compensation: toCompensationTerms(b.compensation),
    ipPolicyVersion: b.ipPolicyVersion,
    trialCapHours: 10,
    founder: {
      displayName: 'Rohan (PayPilot)',
      demoAccount: true,
      companyUrl: null,
      completedSprintCount: 0,
    },
    publishedAt: b.publishedAt,
  };
}

const ok = (data: unknown, status = 200) => ({ status, body: { data, requestId: 'r' } });
const fail = (
  status: number,
  code: string,
  message: string,
  fieldErrors?: Record<string, string[]>,
) => ({
  status,
  body: { error: { code, message, ...(fieldErrors ? { fieldErrors } : {}) }, requestId: 'r' },
});

/** Stateful fake of the brief API with the server's version and state rules. */
function backend(initial: StartupBriefData[] = [], options: { conflict?: boolean } = {}) {
  const briefs = new Map(initial.map((b) => [b.id, b]));
  const calls: Array<{
    method: string;
    path: string;
    body: unknown;
    headers: Record<string, string>;
  }> = [];
  let seq = 0;
  const routes = (method: string, path: string, body: unknown, headers: Record<string, string>) => {
    calls.push({ method, path, body, headers });
    if (path === '/startups' && method === 'GET') {
      return {
        status: 200,
        body: { data: [...briefs.values()], nextCursor: null, requestId: 'r' },
      };
    }
    if (path === '/startups' && method === 'POST') {
      if (!headers['Idempotency-Key']) return fail(400, 'BAD_REQUEST', 'Idempotency-Key missing');
      seq += 1;
      const created = brief({
        id: String(seq).padStart(24, 'c'),
        title: (body as { title: string }).title,
      });
      briefs.set(created.id, created);
      return ok(created, 201);
    }
    const m = /^\/startups\/([a-z0-9]{24})(?:\/(publish|close|clone))?$/.exec(path);
    const current = m ? briefs.get(m[1]!) : undefined;
    if (!m || !current) return fail(404, 'NOT_FOUND', 'The requested resource was not found.');
    const action = m[2];
    if (method === 'GET')
      return ok({ access: 'owner', brief: current, preview: previewOf(current) });
    if (method === 'PATCH') {
      const { expectedVersion, changes } = body as {
        expectedVersion: number;
        changes: Partial<BriefDraftFields>;
      };
      if (options.conflict || expectedVersion !== current.version)
        return fail(409, 'VERSION_CONFLICT', 'changed');
      const next = { ...current, ...changes, version: current.version + 1 };
      briefs.set(next.id, next);
      return ok(next);
    }
    if (!headers['Idempotency-Key']) return fail(400, 'BAD_REQUEST', 'Idempotency-Key missing');
    if (action === 'publish') {
      const next = {
        ...current,
        status: 'open' as const,
        version: 1,
        publishedAt: '2026-10-17T12:00:00.000Z',
      };
      briefs.set(next.id, next);
      return ok(next);
    }
    if (action === 'close') {
      const next = {
        ...current,
        status: 'closed' as const,
        closedAt: '2026-10-18T12:00:00.000Z',
        closeReason: (body as { reason: string }).reason,
      };
      briefs.set(next.id, next);
      return ok(next);
    }
    seq += 1;
    const copy = brief({
      ...current,
      id: String(seq).padStart(24, 'd'),
      status: 'draft',
      version: 0,
      clonedFromId: current.id,
      publishedAt: null,
    });
    briefs.set(copy.id, copy);
    return ok(copy, 201);
  };
  return { routes, calls, briefs };
}

const founder = demoUser(['founder']);

describe('founder brief list', () => {
  it('shows the empty state, creates a draft with an Idempotency-Key and opens it', async () => {
    const api = backend();
    installFakeApi({ user: founder, routes: api.routes });
    renderRoute('/founder/briefs');
    expect(await screen.findByText('No briefs yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create your first brief' }));
    await userEvent.type(screen.getByLabelText(/Brief title/), 'Payment API');
    await userEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Payment API' }),
    ).toBeInTheDocument();
    const post = api.calls.find((c) => c.method === 'POST' && c.path === '/startups')!;
    expect(post.body).toEqual({ title: 'Payment API' });
    expect(post.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('filters by status with counts', async () => {
    const api = backend([
      brief({ id: 'a'.repeat(24), title: 'Draft one' }),
      brief({
        id: 'e'.repeat(24),
        title: 'Open one',
        status: 'open',
        version: 1,
        publishedAt: '2026-10-17T12:00:00.000Z',
      }),
    ]);
    installFakeApi({ user: founder, routes: api.routes });
    renderRoute('/founder/briefs');
    expect(await screen.findByRole('link', { name: 'Draft one' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /Open/ }));
    expect(screen.getByRole('link', { name: 'Open one' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Draft one' })).not.toBeInTheDocument();
  });
});

describe('draft editor', () => {
  it('lists publish requirements and keeps Publish disabled until they are met', async () => {
    installFakeApi({ user: founder, routes: backend([brief()]).routes });
    renderRoute(`/founder/briefs/${ID}`);
    const publish = await screen.findByRole('region', { name: 'Publish' });
    expect(within(publish).getByText(/Before you can publish/)).toBeInTheDocument();
    expect(within(publish).getByText(/Teaser:/)).toBeInTheDocument();
    expect(within(publish).getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(screen.getByRole('region', { name: 'Your idea' })).toHaveTextContent('Confidential');
  });

  it('saves only changed fields with the expected version', async () => {
    const api = backend([brief()]);
    installFakeApi({ user: founder, routes: api.routes });
    renderRoute(`/founder/briefs/${ID}`);
    await userEvent.type(await screen.findByLabelText('Teaser'), 'Short teaser');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Draft saved')).toBeInTheDocument();
    const patch = api.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({ expectedVersion: 0, changes: { teaser: 'Short teaser' } });
    expect(screen.getByText('Draft saved · version 1')).toBeInTheDocument();
  });

  it('blocks saving invalid values on the client', async () => {
    const api = backend([brief()]);
    installFakeApi({ user: founder, routes: api.routes });
    renderRoute(`/founder/briefs/${ID}`);
    await userEvent.type(await screen.findByLabelText('Hours per week'), '50');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Fix the highlighted fields')).toBeInTheDocument();
    expect(screen.getByText('Use 1-40 hours.')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('explains a version conflict and offers to reload', async () => {
    installFakeApi({ user: founder, routes: backend([brief()], { conflict: true }).routes });
    renderRoute(`/founder/briefs/${ID}`);
    await userEvent.type(await screen.findByLabelText('Teaser'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('This brief changed somewhere else')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load the latest version' })).toBeInTheDocument();
  });

  it('publishes a complete draft after confirmation and shows the fixed terms', async () => {
    const api = backend([brief({ ...completeFields, version: 3 })]);
    installFakeApi({ user: founder, routes: api.routes });
    renderRoute(`/founder/briefs/${ID}`);
    const region = await screen.findByRole('region', { name: 'Publish' });
    expect(within(region).getByText('Everything required is filled in.')).toBeInTheDocument();
    await userEvent.click(within(region).getByRole('button', { name: 'Publish' }));
    await userEvent.click(screen.getByRole('button', { name: 'Publish now' }));
    expect(await screen.findByText('Brief published')).toBeInTheDocument();
    const call = api.calls.find((c) => c.path.endsWith('/publish'))!;
    expect(call.body).toEqual({ expectedVersion: 3 });
    expect(call.headers['Idempotency-Key']).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close brief' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
  });

  it('shows "no monetary payment" for unpaid terms', async () => {
    installFakeApi({ user: founder, routes: backend([brief()]).routes });
    renderRoute(`/founder/briefs/${ID}`);
    await userEvent.click(await screen.findByRole('radio', { name: 'Unpaid' }));
    expect(screen.getByText('No monetary payment promised')).toBeInTheDocument();
    expect(screen.queryByLabelText('Amount (₹, INR)')).not.toBeInTheDocument();
  });
});

describe('published brief', () => {
  const open = () =>
    brief({
      ...completeFields,
      status: 'open',
      version: 1,
      publishedAt: '2026-10-17T12:00:00.000Z',
    });

  it('closes with a reason', async () => {
    const api = backend([open()]);
    installFakeApi({ user: founder, routes: api.routes });
    renderRoute(`/founder/briefs/${ID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Close brief' }));
    await userEvent.type(screen.getByLabelText(/Reason/), 'Filled');
    await userEvent.click(screen.getByRole('button', { name: 'Close permanently' }));
    expect(await screen.findByText('Brief closed')).toBeInTheDocument();
    expect(api.calls.find((c) => c.path.endsWith('/close'))!.body).toEqual({ reason: 'Filled' });
  });

  it('clones into a new draft and opens it', async () => {
    const api = backend([open()]);
    installFakeApi({ user: founder, routes: api.routes });
    renderRoute(`/founder/briefs/${ID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Clone to new draft' }));
    expect(await screen.findByText('New draft created from a copy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument();
  });

  it('renders the candidate preview without problem or solution', async () => {
    installFakeApi({ user: founder, routes: backend([open()]).routes });
    renderRoute(`/founder/briefs/${ID}`);
    const preview = await screen.findByRole('article', { name: /Brief preview/ });
    expect(preview).toHaveTextContent('₹2,000');
    expect(preview).not.toHaveTextContent('Problem.');
    expect(preview).not.toHaveTextContent('Solution.');
    expect(screen.getByRole('region', { name: 'Brief details' })).toHaveTextContent('Problem.');
  });

  it('shows a not-found state for briefs that are not visible', async () => {
    installFakeApi({ user: founder, routes: backend([]).routes });
    renderRoute(`/founder/briefs/${'f'.repeat(24)}`);
    expect(await screen.findByText('Brief not found')).toBeInTheDocument();
  });
});

describe('brief form model', () => {
  it('converts rupees to paise and rejects malformed amounts', () => {
    expect(paiseFromRupees('2,000')).toBe(200_000);
    expect(paiseFromRupees('₹ 2000.5')).toBe(200_050);
    expect(paiseFromRupees('')).toBeNull();
    expect(paiseFromRupees('2.555')).toBeNaN();
    expect(paiseFromRupees('-5')).toBeNaN();
  });

  it('round-trips a brief and reports only changed fields', () => {
    const b = brief({
      ...completeFields,
      teamSkills: [
        { skillId: 'nodejs', level: 2 },
        { skillId: 'git', level: 0 },
      ],
    });
    const saved = fieldsFromForm(formFromBrief(b));
    expect(saved.teamSkills).toEqual([{ skillId: 'nodejs', level: 2 }]);
    expect(saved.compensation.amountMinor).toBe(200_000);
    const form = { ...formFromBrief(b), hours: '9' };
    expect(changedFields(saved, fieldsFromForm(form))).toEqual({ hoursRequiredPerWeek: 9 });
  });
});
