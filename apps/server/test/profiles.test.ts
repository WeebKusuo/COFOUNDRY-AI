import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PROFILE_DISCLOSURE_POLICY_VERSION } from '@cofoundry/shared';
import { MemoryIdentityStore } from './support/memory-store.js';
import { MemoryProfileStore } from './support/memory-profile-store.js';
import { TestClient, addTestUser, buildHarness, type Harness } from './support/harness.js';
import type { UserRecord } from '../src/auth/store.js';

const DESCRIPTION = 'Built a REST API in Node.js with request validation, tests and retries.';

/** A complete, discoverable candidate profile body (Section 26 "Asha"-like). */
function completeBody(expectedRevision: number, overrides: Record<string, unknown> = {}) {
  return {
    expectedRevision,
    headline: 'Backend developer',
    bio: 'I like reliable APIs.',
    skills: [
      { skillId: 'nodejs', level: 4 },
      { skillId: 'rest-api', level: 3 },
    ],
    industryTags: ['fintech'],
    missionTags: ['reliability', 'automation'],
    availableHoursPerWeek: 10,
    commitmentMonths: 3,
    opportunityTypes: ['contributor'],
    projects: [
      {
        title: 'Payments API',
        description: DESCRIPTION,
        skillTags: ['nodejs', 'rest-api'],
        url: null,
      },
    ],
    discoveryEnabled: true,
    discoveryConsent: true,
    ...overrides,
  };
}

/** An empty draft body. */
function draftBody(expectedRevision: number, overrides: Record<string, unknown> = {}) {
  return {
    expectedRevision,
    headline: '',
    bio: '',
    skills: [],
    industryTags: [],
    missionTags: [],
    availableHoursPerWeek: null,
    commitmentMonths: null,
    opportunityTypes: [],
    projects: [],
    discoveryEnabled: false,
    discoveryConsent: false,
    ...overrides,
  };
}

let ids: MemoryIdentityStore;
let pstore: MemoryProfileStore;
let h: Harness;
let candidate: UserRecord;
let other: UserRecord;
let founder: UserRecord;

beforeEach(async () => {
  ids = new MemoryIdentityStore();
  pstore = new MemoryProfileStore();
  candidate = await addTestUser(ids, 'cand@test.example', ['candidate']);
  other = await addTestUser(ids, 'other@test.example', ['candidate']);
  founder = await addTestUser(ids, 'founder@test.example', ['founder']);
  await addTestUser(ids, 'dual@test.example', ['founder', 'candidate']);
  h = buildHarness({ store: ids, profileStore: pstore });
});

async function as(email: string) {
  const client = new TestClient(h.app);
  const res = await client.login(email);
  expect(res.status).toBe(200);
  return client;
}

describe('access rules', () => {
  it('requires a session for every profile route', async () => {
    for (const path of ['/candidate/profile', '/founder/profile', `/profiles/${candidate.id}`]) {
      expect((await request(h.app).get(`/api/v1${path}`)).status).toBe(401);
    }
  });

  it('restricts candidate and founder profile routes to their roles', async () => {
    const f = await as('founder@test.example');
    expect((await f.get('/candidate/profile')).status).toBe(403);
    expect((await f.put('/candidate/profile', draftBody(0))).status).toBe(403);
    const c = await as('cand@test.example');
    expect((await c.get('/founder/profile')).status).toBe(403);
    expect(
      (await c.put('/founder/profile', { expectedRevision: 0, bio: '', companyUrl: null })).status,
    ).toBe(403);
    const dual = await as('dual@test.example');
    expect((await dual.get('/founder/profile')).status).toBe(200);
    expect((await dual.get('/candidate/profile')).status).toBe(200);
  });

  it('requires CSRF for profile updates', async () => {
    const c = await as('cand@test.example');
    const res = await c.agent
      .put('/api/v1/candidate/profile')
      .set('Origin', 'http://localhost:5173')
      .send(draftBody(0));
    expect(res.status).toBe(403);
  });
});

describe('candidate profile CRUD and revisions', () => {
  it('returns a blank, unsaved profile (revision 0) before the first save', async () => {
    const c = await as('cand@test.example');
    const res = await c.get('/candidate/profile');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      userId: candidate.id,
      revision: 0,
      skills: [],
      projects: [],
      discoveryEnabled: false,
      discoveryConsent: false,
      updatedAt: null,
    });
  });

  it('creates with expectedRevision 0, then increments on every accepted update', async () => {
    const c = await as('cand@test.example');
    const created = await c.put('/candidate/profile', draftBody(0, { headline: 'Hello' }));
    expect(created.status).toBe(200);
    expect(created.body.data.revision).toBe(1);
    const updated = await c.put('/candidate/profile', draftBody(1, { headline: 'Hello again' }));
    expect(updated.body.data).toMatchObject({ revision: 2, headline: 'Hello again' });
    const read = await c.get('/candidate/profile');
    expect(read.body.data.revision).toBe(2);
  });

  it('rejects stale writes with 409 VERSION_CONFLICT', async () => {
    const c = await as('cand@test.example');
    await c.put('/candidate/profile', draftBody(0));
    const again = await c.put('/candidate/profile', draftBody(0));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('VERSION_CONFLICT');
    const ahead = await c.put('/candidate/profile', draftBody(5));
    expect(ahead.status).toBe(409);
  });

  it('allows incomplete drafts while discovery is off', async () => {
    const c = await as('cand@test.example');
    const res = await c.put(
      '/candidate/profile',
      draftBody(0, { skills: [{ skillId: 'git', level: 2 }] }),
    );
    expect(res.status).toBe(200);
    expect(res.body.data.discoveryEnabled).toBe(false);
  });

  it('normalises text (NFKC, trimmed) and stores it as plain text', async () => {
    const c = await as('cand@test.example');
    const res = await c.put(
      '/candidate/profile',
      draftBody(0, { headline: '  ＡＰＩ <b>builder</b> ', bio: ' ﬁne ' }),
    );
    expect(res.body.data.headline).toBe('API <b>builder</b>');
    expect(res.body.data.bio).toBe('fine');
  });

  it('never lets the client write server-owned fields', async () => {
    const c = await as('cand@test.example');
    for (const extra of [{ revision: 9 }, { userId: other.id }, { discoveryConsentAt: 'x' }]) {
      const res = await c.put('/candidate/profile', { ...draftBody(0), ...extra });
      expect(res.status).toBe(422);
    }
    const project = {
      title: 'X',
      description: DESCRIPTION,
      skillTags: ['git'],
      url: null,
      evidenceStatus: 'project_linked',
    };
    const res = await c.put('/candidate/profile', draftBody(0, { projects: [project] }));
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.fieldErrors)).toContain('body.projects.0.evidenceStatus');
  });
});

describe('validation (Section 03)', () => {
  let c: TestClient;
  beforeEach(async () => {
    c = await as('cand@test.example');
  });

  const errorsFor = async (overrides: Record<string, unknown>) => {
    const res = await c.put('/candidate/profile', draftBody(0, overrides));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    return res.body.error.fieldErrors as Record<string, string[]>;
  };

  it('accepts only the fixed skill aliases and rejects free text with the allowed choices', async () => {
    const ok = await c.put(
      '/candidate/profile',
      draftBody(0, {
        skills: [
          { skillId: 'Node.js', level: 3 },
          { skillId: 'mongo', level: 2 },
        ],
      }),
    );
    expect(ok.body.data.skills).toEqual([
      { skillId: 'nodejs', level: 3 },
      { skillId: 'mongodb', level: 2 },
    ]);
    const errs = await errorsFor({ skills: [{ skillId: 'python', level: 3 }] });
    expect(errs['body.skills.0.skillId']?.[0]).toMatch(/Choose one of: nodejs, javascript/);
  });

  it.each([
    [
      'duplicate skills (after alias resolution)',
      {
        skills: [
          { skillId: 'node', level: 2 },
          { skillId: 'nodejs', level: 3 },
        ],
      },
      'body.skills',
    ],
    ['level 0', { skills: [{ skillId: 'git', level: 0 }] }, 'body.skills.0.level'],
    ['level 6', { skills: [{ skillId: 'git', level: 6 }] }, 'body.skills.0.level'],
    ['fractional level', { skills: [{ skillId: 'git', level: 2.5 }] }, 'body.skills.0.level'],
    [
      '13 skills',
      {
        skills: [
          'nodejs',
          'javascript',
          'typescript',
          'rest-api',
          'authentication',
          'mongodb',
          'sql',
          'testing',
          'debugging',
          'docker',
          'git',
          'system-design',
          'nodejs',
        ].map((skillId) => ({ skillId, level: 1 })),
      },
      'body.skills',
    ],
    ['0 hours', { availableHoursPerWeek: 0 }, 'body.availableHoursPerWeek'],
    ['41 hours', { availableHoursPerWeek: 41 }, 'body.availableHoursPerWeek'],
    ['fractional hours', { availableHoursPerWeek: 7.5 }, 'body.availableHoursPerWeek'],
    ['13 months', { commitmentMonths: 13 }, 'body.commitmentMonths'],
    ['unknown industry', { industryTags: ['gaming'] }, 'body.industryTags.0'],
    [
      '6 missions',
      {
        missionTags: [
          'access',
          'affordability',
          'privacy',
          'sustainability',
          'automation',
          'reliability',
        ],
      },
      'body.missionTags',
    ],
    ['duplicate industries', { industryTags: ['fintech', 'fintech'] }, 'body.industryTags'],
    [
      'non-contributor opportunity',
      { opportunityTypes: ['co-founder'] },
      'body.opportunityTypes.0',
    ],
    ['161-char headline', { headline: 'x'.repeat(161) }, 'body.headline'],
    ['1001-char bio', { bio: 'x'.repeat(1001) }, 'body.bio'],
  ])('rejects %s', async (_label, overrides, field) => {
    const errs = await errorsFor(overrides);
    expect(Object.keys(errs)).toContain(field);
  });

  it.each([
    ['49-char description', { description: 'x'.repeat(49) }, 'body.projects.0.description'],
    ['1501-char description', { description: 'x'.repeat(1501) }, 'body.projects.0.description'],
    ['empty title', { title: '  ' }, 'body.projects.0.title'],
    ['101-char title', { title: 'x'.repeat(101) }, 'body.projects.0.title'],
    ['no skill tags', { skillTags: [] }, 'body.projects.0.skillTags'],
    [
      '9 skill tags',
      {
        skillTags: [
          'nodejs',
          'javascript',
          'typescript',
          'rest-api',
          'authentication',
          'mongodb',
          'sql',
          'testing',
          'debugging',
        ],
      },
      'body.projects.0.skillTags',
    ],
    ['http link', { url: 'http://example.com/repo' }, 'body.projects.0.url'],
    ['IP link', { url: 'https://10.0.0.1/repo' }, 'body.projects.0.url'],
    ['localhost link', { url: 'https://localhost/repo' }, 'body.projects.0.url'],
    ['link with credentials', { url: 'https://user:pass@example.com' }, 'body.projects.0.url'],
    ['javascript: link', { url: 'javascript:alert(1)' }, 'body.projects.0.url'],
  ])('rejects a project with %s', async (_label, override, field) => {
    const project = {
      title: 'API',
      description: DESCRIPTION,
      skillTags: ['nodejs'],
      url: null,
      ...override,
    };
    const errs = await errorsFor({ projects: [project] });
    expect(Object.keys(errs)).toContain(field);
  });

  it('allows at most 5 projects', async () => {
    const project = { title: 'API', description: DESCRIPTION, skillTags: ['nodejs'], url: null };
    const errs = await errorsFor({ projects: Array.from({ length: 6 }, () => project) });
    expect(errs['body.projects']).toBeDefined();
    const ok = await c.put(
      '/candidate/profile',
      draftBody(0, { projects: Array.from({ length: 5 }, () => project) }),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.data.projects).toHaveLength(5);
  });
});

describe('projects and evidence labels', () => {
  it('derives project_linked only from a valid HTTPS link and keeps server ids stable', async () => {
    const c = await as('cand@test.example');
    const res = await c.put(
      '/candidate/profile',
      draftBody(0, {
        projects: [
          {
            title: 'Linked',
            description: DESCRIPTION,
            skillTags: ['nodejs'],
            url: 'https://github.com/a/b',
          },
          { title: 'Plain', description: DESCRIPTION, skillTags: ['git'], url: '' },
        ],
      }),
    );
    const [linked, plain] = res.body.data.projects;
    expect(linked).toMatchObject({
      evidenceStatus: 'project_linked',
      url: 'https://github.com/a/b',
    });
    expect(plain).toMatchObject({ evidenceStatus: 'self_reported', url: null });
    expect(linked.id).toMatch(/^[a-f0-9]{24}$/);

    // Editing the first project while removing the second keeps the first id.
    const next = await c.put(
      '/candidate/profile',
      draftBody(1, {
        projects: [
          {
            id: linked.id,
            title: 'Linked v2',
            description: DESCRIPTION,
            skillTags: ['nodejs'],
            url: null,
          },
        ],
      }),
    );
    expect(next.body.data.projects).toEqual([
      expect.objectContaining({
        id: linked.id,
        title: 'Linked v2',
        evidenceStatus: 'self_reported',
      }),
    ]);
  });

  it('rejects ids that do not belong to the profile', async () => {
    const c = await as('cand@test.example');
    const res = await c.put(
      '/candidate/profile',
      draftBody(0, {
        projects: [
          {
            id: 'a'.repeat(24),
            title: 'X',
            description: DESCRIPTION,
            skillTags: ['git'],
            url: null,
          },
        ],
      }),
    );
    expect(res.status).toBe(422);
    expect(res.body.error.fieldErrors['body.projects.0.id']).toEqual(['Unknown project.']);
  });
});

describe('discovery and consent (Sections 03, 14)', () => {
  it('lists every missing requirement when discovery is turned on too early', async () => {
    const c = await as('cand@test.example');
    const res = await c.put('/candidate/profile', draftBody(0, { discoveryEnabled: true }));
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.fieldErrors).sort()).toEqual([
      'body.availableHoursPerWeek',
      'body.commitmentMonths',
      'body.discoveryConsent',
      'body.industryTags',
      'body.missionTags',
      'body.opportunityTypes',
      'body.skills',
    ]);
  });

  it('requires disclosure consent even when everything else is complete', async () => {
    const c = await as('cand@test.example');
    const res = await c.put('/candidate/profile', completeBody(0, { discoveryConsent: false }));
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.fieldErrors)).toEqual(['body.discoveryConsent']);
  });

  it('does not require projects for discovery', async () => {
    const c = await as('cand@test.example');
    const res = await c.put('/candidate/profile', completeBody(0, { projects: [] }));
    expect(res.status).toBe(200);
    expect(res.body.data.discoveryEnabled).toBe(true);
  });

  it('records consent with the policy version and withdraws it on request', async () => {
    const c = await as('cand@test.example');
    const on = await c.put('/candidate/profile', completeBody(0));
    expect(on.body.data).toMatchObject({ discoveryEnabled: true, discoveryConsent: true });
    expect(pstore.consents).toEqual([
      expect.objectContaining({
        userId: candidate.id,
        purpose: 'profile_discovery',
        targetId: candidate.id,
        policyVersion: PROFILE_DISCLOSURE_POLICY_VERSION,
        withdrawnAt: null,
      }),
    ]);

    // Withdrawing consent while still discoverable is refused.
    const bad = await c.put('/candidate/profile', completeBody(1, { discoveryConsent: false }));
    expect(bad.status).toBe(422);

    const off = await c.put(
      '/candidate/profile',
      completeBody(1, { discoveryEnabled: false, discoveryConsent: false }),
    );
    expect(off.body.data).toMatchObject({ discoveryEnabled: false, discoveryConsent: false });
    expect(pstore.consents[0]?.withdrawnAt).toBeInstanceOf(Date);

    // Re-granting creates a new active record; history is kept.
    await c.put('/candidate/profile', completeBody(2));
    expect(pstore.consents).toHaveLength(2);
    expect(pstore.consents.filter((r) => r.withdrawnAt === null)).toHaveLength(1);
  });

  it('can keep consent while discovery is off', async () => {
    const c = await as('cand@test.example');
    const res = await c.put('/candidate/profile', completeBody(0, { discoveryEnabled: false }));
    expect(res.body.data).toMatchObject({ discoveryEnabled: false, discoveryConsent: true });
  });

  it('never exposes a profile when the profile write fails after consent was granted', async () => {
    const c = await as('cand@test.example');
    pstore.failNextCandidateSave = true;
    const res = await c.put('/candidate/profile', completeBody(0));
    expect(res.status).toBe(500);
    const f = await as('founder@test.example');
    expect((await f.get(`/profiles/${candidate.id}`)).status).toBe(404);
    // Repeating the request completes it.
    expect((await c.put('/candidate/profile', completeBody(0))).status).toBe(200);
    expect((await f.get(`/profiles/${candidate.id}`)).status).toBe(200);
  });
});

describe('GET /profiles/:userId (ProfilePublic)', () => {
  beforeEach(async () => {
    const c = await as('cand@test.example');
    await c.put(
      '/candidate/profile',
      completeBody(0, {
        projects: [
          {
            title: 'Linked',
            description: DESCRIPTION,
            skillTags: ['nodejs'],
            url: 'https://github.com/a/b',
          },
        ],
      }),
    );
  });

  it('shows a discoverable candidate in the same cohort without private fields', async () => {
    const f = await as('founder@test.example');
    const res = await f.get(`/profiles/${candidate.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      userId: candidate.id,
      displayName: 'cand',
      demoAccount: true,
      founder: null,
      candidate: { headline: 'Backend developer', availableHoursPerWeek: 10 },
    });
    const json = JSON.stringify(res.body);
    for (const secret of [
      'cand@test.example',
      'revision',
      'discoveryConsent',
      'discoveryEnabled',
      'consent',
      'passwordHash',
      'cohortId',
      'policyVersion',
    ]) {
      expect(json).not.toContain(secret);
    }
    expect(res.body.data.candidate.projects[0]).toMatchObject({ evidenceStatus: 'project_linked' });
  });

  it('hides non-discoverable profiles as 404', async () => {
    const c = await as('cand@test.example');
    await c.put('/candidate/profile', completeBody(1, { discoveryEnabled: false }));
    const f = await as('founder@test.example');
    const res = await f.get(`/profiles/${candidate.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('hides the profile if consent disappears even though the flag is still on', async () => {
    await pstore.withdrawConsent(
      { userId: candidate.id, purpose: 'profile_discovery', targetId: candidate.id },
      new Date(),
    );
    const f = await as('founder@test.example');
    expect((await f.get(`/profiles/${candidate.id}`)).status).toBe(404);
    const c = await as('cand@test.example');
    expect((await c.get('/candidate/profile')).body.data.discoveryEnabled).toBe(false);
  });

  it('hides other cohorts, suspended accounts, unknown and malformed ids — all as 404', async () => {
    const outsider = await addTestUser(ids, 'outsider@test.example', ['founder'], {
      cohortId: 'other',
    });
    const o = new TestClient(h.app);
    await o.login('outsider@test.example');
    expect((await o.get(`/profiles/${candidate.id}`)).status).toBe(404);
    expect(outsider.cohortId).toBe('other');

    const f = await as('founder@test.example');
    expect((await f.get(`/profiles/${'b'.repeat(24)}`)).status).toBe(404);
    expect((await f.get('/profiles/not-an-id')).status).toBe(404);
    expect((await f.get(`/profiles/${other.id}`)).status).toBe(404); // no profile at all
    expect((await f.get(`/profiles/${founder.id}`)).status).toBe(200); // own profile
    (await ids.findUserById(candidate.id))!.status = 'suspended';
    expect((await f.get(`/profiles/${candidate.id}`)).status).toBe(404);
  });

  it("never shows another founder's profile", async () => {
    const f = await as('founder@test.example');
    await f.put('/founder/profile', { expectedRevision: 0, bio: 'Founder bio', companyUrl: null });
    const c = await as('cand@test.example');
    expect((await c.get(`/profiles/${founder.id}`)).status).toBe(404);
  });

  it('lets users preview their own public profile, even when not discoverable', async () => {
    const o = await as('other@test.example');
    await o.put('/candidate/profile', draftBody(0, { headline: 'Private draft' }));
    const res = await o.get(`/profiles/${other.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.candidate.headline).toBe('Private draft');
  });
});

describe('founder profile', () => {
  it('creates and updates bio and company link with revisions', async () => {
    const f = await as('founder@test.example');
    expect((await f.get('/founder/profile')).body.data).toMatchObject({
      revision: 0,
      bio: '',
      companyUrl: null,
    });
    const created = await f.put('/founder/profile', {
      expectedRevision: 0,
      bio: '  Building PayPilot.  ',
      companyUrl: 'https://paypilot.example',
    });
    expect(created.body.data).toMatchObject({
      revision: 1,
      bio: 'Building PayPilot.',
      companyUrl: 'https://paypilot.example/',
    });
    const cleared = await f.put('/founder/profile', {
      expectedRevision: 1,
      bio: '',
      companyUrl: '',
    });
    expect(cleared.body.data).toMatchObject({ revision: 2, companyUrl: null });
    expect(
      (await f.put('/founder/profile', { expectedRevision: 1, bio: '', companyUrl: null })).status,
    ).toBe(409);
  });

  it.each([
    [{ companyUrl: 'http://paypilot.example' }, 'body.companyUrl'],
    [{ companyUrl: 'https://192.168.1.10' }, 'body.companyUrl'],
    [{ bio: 'x'.repeat(1001) }, 'body.bio'],
    [{ startupName: 'PayPilot' }, 'body.startupName'],
  ])('rejects %j', async (override, field) => {
    const f = await as('founder@test.example');
    const res = await f.put('/founder/profile', {
      expectedRevision: 0,
      bio: '',
      companyUrl: null,
      ...override,
    });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.fieldErrors)).toContain(field);
  });
});

describe('/me profile summaries', () => {
  it('reports each saved profile with revision and completeness', async () => {
    const dual = await as('dual@test.example');
    expect((await dual.get('/me')).body.data.profileSummaries).toEqual([]);
    await dual.put('/founder/profile', { expectedRevision: 0, bio: 'Hi', companyUrl: null });
    await dual.put('/candidate/profile', draftBody(0));
    expect((await dual.get('/me')).body.data.profileSummaries).toEqual([
      { role: 'founder', revision: 1, complete: true },
      { role: 'candidate', revision: 1, complete: false },
    ]);
    await dual.put(
      '/candidate/profile',
      completeBody(1, { discoveryEnabled: false, discoveryConsent: false }),
    );
    expect((await dual.get('/me')).body.data.profileSummaries[1]).toEqual({
      role: 'candidate',
      revision: 2,
      complete: true,
    });
  });
});
