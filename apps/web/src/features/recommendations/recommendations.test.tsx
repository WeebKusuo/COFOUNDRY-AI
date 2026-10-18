import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  BriefOwnerSummary,
  RecommendationEntryView,
  RecommendationSearchResponse,
} from '@cofoundry/shared';
import { renderRoute } from '../../test/render';
import { demoUser, installFakeApi } from '../../test/fake-api';

const BRIEF_ID = 'a'.repeat(24);
const brief = (overrides: Partial<BriefOwnerSummary> = {}): BriefOwnerSummary => ({
  id: BRIEF_ID,
  status: 'open',
  version: 1,
  title: 'PayPilot payment reconciliation API',
  teaser: 'Teaser',
  publishedAt: '2026-10-17T10:00:00.000Z',
  closedAt: null,
  clonedFromId: null,
  createdAt: '2026-10-17T10:00:00.000Z',
  updatedAt: '2026-10-17T10:00:00.000Z',
  ...overrides,
});

function entry(overrides: Partial<RecommendationEntryView>): RecommendationEntryView {
  return {
    candidateUserId: 'c'.repeat(24),
    profileRevision: 1,
    group: 'recommendations',
    score: 73.392857142857,
    components: { S: 71.4285714, A: 100, I: 75, P: 42.857142857 },
    weights: { S: 0.4, A: 0.25, I: 0.15, P: 0.2 },
    coverageWeight: 1,
    provisional: false,
    missingFactors: [],
    nearMatchDeficits: [],
    reasons: ['Covers 71.43% of the weighted skill gap (meets REST APIs).'],
    skills: [
      {
        skillId: 'nodejs',
        requiredLevel: 4,
        teamLevel: 2,
        gap: 2,
        importance: 2,
        mandatory: false,
        candidateLevel: 2,
        fit: 0.5,
        weightShare: 4 / 7,
      },
      {
        skillId: 'rest-api',
        requiredLevel: 3,
        teamLevel: 0,
        gap: 3,
        importance: 1,
        mandatory: true,
        candidateLevel: 3,
        fit: 1,
        weightShare: 3 / 7,
      },
    ],
    projects: [
      {
        projectId: 'p'.repeat(24),
        title: 'REST service',
        score: 42.857142857,
        matchedGapSkills: ['rest-api'],
      },
    ],
    bestProjectId: 'p'.repeat(24),
    profile: {
      displayName: 'Dev',
      demoAccount: true,
      headline: 'API developer',
      bio: 'I build REST services.',
      skills: [
        { skillId: 'nodejs', level: 2 },
        { skillId: 'rest-api', level: 3 },
      ],
      industryTags: ['fintech'],
      missionTags: ['reliability'],
      availableHoursPerWeek: 8,
      commitmentMonths: 3,
      projects: [
        {
          id: 'p'.repeat(24),
          title: 'REST service',
          description:
            'A REST service with tests and retries for ledger exports, built in Node.js.',
          skillTags: ['rest-api'],
          url: 'https://github.com/dev/rest-service',
          evidenceStatus: 'project_linked',
        },
      ],
    },
    ...overrides,
  };
}

function batch(
  overrides: Partial<RecommendationSearchResponse> = {},
): RecommendationSearchResponse {
  const now = Date.now();
  return {
    batchId: 'b'.repeat(24),
    briefId: BRIEF_ID,
    briefVersion: 1,
    generatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 15 * 60_000).toISOString(),
    algorithmVersion: 'match-v3.0',
    recommendations: [entry({})],
    provisional: [
      entry({
        candidateUserId: 'd'.repeat(24),
        group: 'provisional',
        score: 100,
        provisional: true,
        coverageWeight: 0.8,
        missingFactors: ['projectRelevance'],
        components: { S: 100, A: 100, I: 100, P: null },
        weights: { S: 0.5, A: 0.3125, I: 0.1875, P: null },
        projects: [],
        bestProjectId: null,
        profile: { ...entry({}).profile, displayName: 'Isha', projects: [] },
      }),
    ],
    nearMatches: [
      entry({
        candidateUserId: 'e'.repeat(24),
        group: 'nearMatches',
        score: 96.6666667,
        nearMatchDeficits: [{ factor: 'months', required: 3, offered: 2 }],
        reasons: [
          'Covers 100% of the weighted skill gap.',
          'Offers 2 months; the brief asks for 3 (not mandatory).',
        ],
        profile: { ...entry({}).profile, displayName: 'Nila' },
      }),
    ],
    exclusions: {
      totalExcluded: 2,
      gates: [
        { code: 'opportunity_type', count: 0 },
        { code: 'essential_skill', count: 1 },
        { code: 'minimum_hours', count: 1 },
        { code: 'minimum_commitment', count: 0 },
      ],
    },
    ...overrides,
  };
}

const ok = (data: unknown, status = 200) => ({ status, body: { data, requestId: 'r' } });
const fail = (status: number, code: string, message: string) => ({
  status,
  body: { error: { code, message }, requestId: 'r' },
});

function backend(options: {
  briefs?: BriefOwnerSummary[];
  latest?: () => { status: number; body: unknown };
  search?: () => { status: number; body: unknown };
  interviews?: unknown[];
  invite?: () => { status: number; body: unknown };
}) {
  const calls: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
  const routes = (
    method: string,
    path: string,
    _body: unknown,
    headers: Record<string, string>,
  ) => {
    calls.push({ method, path, headers });
    if (path === '/startups' && method === 'GET') {
      return {
        status: 200,
        body: { data: options.briefs ?? [brief()], nextCursor: null, requestId: 'r' },
      };
    }
    if (path === '/interviews' && method === 'GET') {
      return {
        status: 200,
        body: { data: options.interviews ?? [], nextCursor: null, requestId: 'r' },
      };
    }
    if (path === '/interviews' && method === 'POST') {
      return (options.invite ?? (() => ok({ id: 'f'.repeat(24), status: 'invited' }, 201)))();
    }
    if (path === `/startups/${BRIEF_ID}/recommendations`) {
      if (method === 'GET')
        return (
          options.latest ??
          (() =>
            fail(409, 'STALE_RECOMMENDATION', 'No current results for this brief. Run a search.'))
        )();
      return (options.search ?? (() => ok(batch(), 201)))();
    }
    return undefined;
  };
  return { routes, calls };
}

const founder = demoUser(['founder']);

describe('founder recommendations dashboard', () => {
  it('explains that an open brief is needed', async () => {
    installFakeApi({
      user: founder,
      routes: backend({ briefs: [brief({ status: 'draft' })] }).routes,
    });
    renderRoute('/founder/candidates');
    expect(await screen.findByText('No open brief to match')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to your briefs' })).toHaveAttribute(
      'href',
      '/founder/briefs',
    );
  });

  it('runs a server search with an Idempotency-Key and renders the three separate groups', async () => {
    const api = backend({});
    installFakeApi({ user: founder, routes: api.routes });
    renderRoute('/founder/candidates');
    expect(await screen.findByText('No current results')).toBeInTheDocument();
    expect(screen.getByText(/No current results for this brief/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Find candidates' }));

    const recommended = await screen.findByRole('region', { name: 'Recommended' });
    const provisional = screen.getByRole('region', { name: 'Provisional' });
    const near = screen.getByRole('region', { name: 'Near matches' });
    expect(within(recommended).getByRole('heading', { name: 'Dev' })).toBeInTheDocument();
    expect(within(recommended).getByText('73.39')).toBeInTheDocument();
    expect(within(provisional).getByRole('heading', { name: 'Isha' })).toBeInTheDocument();
    expect(within(provisional).getByText('No projects')).toBeInTheDocument();
    expect(within(provisional).getByText('weight 50%')).toBeInTheDocument();
    expect(within(near).getByText('96.67')).toBeInTheDocument();
    expect(within(near).getByText(/Offers 2 months/)).toBeInTheDocument();
    expect(within(recommended).queryByText('Isha')).not.toBeInTheDocument();

    const post = api.calls.find((c) => c.method === 'POST')!;
    expect(post.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      screen.getByText(/2 discoverable candidates did not meet a hard requirement/),
    ).toHaveTextContent('below a mandatory skill level (1), fewer weekly hours than required (1)');
  });

  it('shows the score breakdown, remaining gaps and a privacy-safe detail view', async () => {
    installFakeApi({ user: founder, routes: backend({ latest: () => ok(batch()) }).routes });
    renderRoute('/founder/candidates');
    const card = (await screen.findByRole('article', { name: /Dev, score 73.39/ })) as HTMLElement;
    expect(within(card).getByText('Skill coverage')).toBeInTheDocument();
    expect(within(card).getByText('71.43')).toBeInTheDocument();
    expect(within(card).getByText('42.86')).toBeInTheDocument();
    expect(within(card).getByText(/Remaining skill gaps:/).parentElement).toHaveTextContent(
      'Node.js (has 2, needs 4)',
    );
    await userEvent.click(within(card).getByRole('button', { name: 'View details' }));
    const table = within(card).getByRole('table');
    expect(within(table).getByRole('rowheader', { name: /REST APIs/ })).toHaveTextContent(
      '(mandatory)',
    );
    expect(within(card).getByText('Best match')).toBeInTheDocument();
    expect(
      within(card).getByRole('button', { name: /Self-reported link: github.com/ }),
    ).toBeInTheDocument();
    expect(card).not.toHaveTextContent('@');
  });

  it('invites a candidate after confirmation, sending the batch and an Idempotency-Key', async () => {
    const api = backend({ latest: () => ok(batch()) });
    installFakeApi({ user: founder, routes: api.routes });
    renderRoute('/founder/candidates');
    const card = (await screen.findByRole('article', { name: /Dev, score/ })) as HTMLElement;
    await userEvent.click(within(card).getByRole('button', { name: 'Invite to interview' }));
    expect(within(card).getByText(/They get 7 days to accept/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Send invitation' }));
    expect(await within(card).findByText('Invitation sent to Dev.')).toBeInTheDocument();
    const post = api.calls.find((c) => c.method === 'POST' && c.path === '/interviews')!;
    expect(post.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('shows the existing interview instead of a second invite, and server refusals', async () => {
    const api = backend({
      latest: () => ok(batch()),
      interviews: [
        {
          id: 'f'.repeat(24),
          candidateUserId: 'c'.repeat(24),
          status: 'accepted',
          evaluationStatus: 'none',
        },
      ],
      invite: () => fail(409, 'STALE_RECOMMENDATION', 'These results are out of date.'),
    });
    installFakeApi({ user: founder, routes: api.routes });
    renderRoute('/founder/candidates');
    const dev = (await screen.findByRole('article', { name: /Dev, score/ })) as HTMLElement;
    expect(await within(dev).findByText('Accepted')).toBeInTheDocument();
    expect(
      within(dev).queryByRole('button', { name: 'Invite to interview' }),
    ).not.toBeInTheDocument();
    const isha = (await screen.findByRole('article', { name: /Isha/ })) as HTMLElement;
    await userEvent.click(within(isha).getByRole('button', { name: 'Invite to interview' }));
    await userEvent.click(within(isha).getByRole('button', { name: 'Send invitation' }));
    expect(await within(isha).findByRole('alert')).toHaveTextContent(
      /out of date\. Run a new search/,
    );
  });

  it('warns when results expired and offers a new search', async () => {
    const past = Date.now() - 60_000;
    installFakeApi({
      user: founder,
      routes: backend({
        latest: () =>
          ok(
            batch({
              generatedAt: new Date(past - 15 * 60_000).toISOString(),
              expiresAt: new Date(past).toISOString(),
            }),
          ),
      }).routes,
    });
    renderRoute('/founder/candidates');
    expect(await screen.findByText('These results expired')).toBeInTheDocument();
    expect(screen.getAllByText(/Run a new search before inviting anyone/).length).toBeGreaterThan(
      0,
    );
  });

  it('shows an empty group message rather than padding it', async () => {
    installFakeApi({
      user: founder,
      routes: backend({ latest: () => ok(batch({ nearMatches: [] })) }).routes,
    });
    renderRoute('/founder/candidates');
    const near = await screen.findByRole('region', { name: 'Near matches' });
    expect(
      within(near).getByText('No candidates scored 50 or more in this group.'),
    ).toBeInTheDocument();
  });

  it('shows retryable errors and the search rate limit', async () => {
    installFakeApi({
      user: founder,
      routes: backend({ search: () => fail(429, 'RATE_LIMITED', 'Too many requests.') }).routes,
    });
    renderRoute('/founder/candidates');
    await userEvent.click(await screen.findByRole('button', { name: 'Find candidates' }));
    expect(
      await screen.findByText('Too many searches. Wait a minute and try again.'),
    ).toBeInTheDocument();
  });

  it('shows an error state with retry when loading fails', async () => {
    installFakeApi({
      user: founder,
      routes: backend({
        latest: () => fail(500, 'INTERNAL_ERROR', 'Something went wrong on our side. Try again.'),
      }).routes,
    });
    renderRoute('/founder/candidates');
    expect(await screen.findByRole('button', { name: /Try again|Retry/ })).toBeInTheDocument();
  });
});
