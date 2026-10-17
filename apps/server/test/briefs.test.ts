import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryIdentityStore } from './support/memory-store.js';
import { MemoryBriefStore, MemoryIdempotencyStore } from './support/memory-brief-store.js';
import { MemoryProfileStore } from './support/memory-profile-store.js';
import { TestClient, addTestUser, buildHarness, type Harness } from './support/harness.js';
import type { UserRecord } from '../src/auth/store.js';

const TEXT_60 = 'We reconcile UPI and bank payments for small merchants each day.';

/** Every field needed to publish (Section 26 PayPilot-like). */
function completeChanges(overrides: Record<string, unknown> = {}) {
  return {
    teaser: 'Harden our Node.js reconciliation API in a bounded backend contributor trial.',
    problem: `Problem: ${TEXT_60}`,
    solution: `Solution: ${TEXT_60}`,
    industryTags: ['fintech'],
    missionTags: ['reliability', 'automation'],
    teamSkills: [{ skillId: 'nodejs', level: 2 }],
    requiredSkills: [
      { skillId: 'nodejs', level: 4, importance: 2, mandatory: false },
      { skillId: 'rest-api', level: 3, importance: 1, mandatory: true },
    ],
    hoursRequiredPerWeek: 8,
    commitmentMonths: 3,
    mandatoryAvailability: true,
    mandatoryCommitment: false,
    compensation: {
      type: 'paid',
      amountMinor: 200_000,
      paymentDueDays: 7,
      methodNote: 'External bank/UPI transfer agreed directly.',
      benefitDescription: '',
    },
    ...overrides,
  };
}

let ids: MemoryIdentityStore;
let briefStore: MemoryBriefStore;
let idem: MemoryIdempotencyStore;
let h: Harness;
let founder: UserRecord;
let candidate: UserRecord;

beforeEach(async () => {
  ids = new MemoryIdentityStore();
  briefStore = new MemoryBriefStore();
  idem = new MemoryIdempotencyStore();
  founder = await addTestUser(ids, 'founder@test.example', ['founder']);
  await addTestUser(ids, 'founder2@test.example', ['founder']);
  candidate = await addTestUser(ids, 'cand@test.example', ['candidate']);
  await addTestUser(ids, 'elsewhere@test.example', ['candidate'], { cohortId: 'other-cohort' });
  await addTestUser(ids, 'dual@test.example', ['founder', 'candidate']);
  await addTestUser(ids, 'mod@test.example', ['moderator']);
  h = buildHarness({
    store: ids,
    profileStore: new MemoryProfileStore(),
    briefStore,
    idempotencyStore: idem,
  });
});

async function as(email: string) {
  const client = new TestClient(h.app);
  expect((await client.login(email)).status).toBe(200);
  return client;
}

const key = () => ({ 'Idempotency-Key': randomUUID() });

async function createDraft(c: TestClient, body: object = { title: 'Webhook worker' }) {
  const res = await c.post('/startups', body, key());
  expect(res.status).toBe(201);
  return res.body.data as { id: string; version: number; status: string };
}

async function publishedBrief(c: TestClient) {
  const draft = await createDraft(c);
  const patched = await c.patch(`/startups/${draft.id}`, {
    expectedVersion: 0,
    changes: completeChanges(),
  });
  expect(patched.status).toBe(200);
  const pub = await c.post(`/startups/${draft.id}/publish`, { expectedVersion: 1 }, key());
  expect(pub.status).toBe(200);
  return pub.body.data as { id: string };
}

describe('POST /startups (create draft)', () => {
  it('creates a version-0 draft owned by the session founder with server constants', async () => {
    const f = await as('founder@test.example');
    const res = await f.post('/startups', { title: '  Webhook worker  ' }, key());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'draft',
      version: 0,
      title: 'Webhook worker',
      roleKey: 'backend-node-v1',
      opportunityType: 'contributor',
      workMode: 'remote',
      ipPolicyVersion: 'creator-owned-v3.0',
      compensation: { type: 'paid', amountMinor: null },
      publishedAt: null,
    });
    expect(briefStore.records.get(res.body.data.id)?.founderUserId).toBe(founder.id);
  });

  it('requires the founder role, CSRF and an Idempotency-Key', async () => {
    const c = await as('cand@test.example');
    expect((await c.post('/startups', { title: 'x' }, key())).status).toBe(403);
    const f = await as('founder@test.example');
    const missing = await f.post('/startups', { title: 'x' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toMatch(/Idempotency-Key/);
    expect((await f.post('/startups', { title: 'x' }, { 'Idempotency-Key': 'nope' })).status).toBe(
      400,
    );
    f.csrf = 'wrong';
    const csrf = await f.agent
      .post('/api/v1/startups')
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', 'wrong')
      .set(key())
      .send({ title: 'x' });
    expect(csrf.status).toBe(403);
    expect(csrf.body.error.code).toBe('CSRF_INVALID');
  });

  it('rejects unknown and server-owned fields and requires a title', async () => {
    const f = await as('founder@test.example');
    for (const body of [
      { title: 'A', status: 'open' },
      { title: 'A', version: 3 },
      { title: 'A', founderUserId: candidate.id },
      { title: 'A', ipPolicyVersion: 'mine' },
      { teaser: 'no title' },
      { title: '' },
      { title: 'x'.repeat(101) },
    ]) {
      const res = await f.post('/startups', body, key());
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('replays the same key with the same body without creating a duplicate', async () => {
    const f = await as('founder@test.example');
    const headers = key();
    const first = await f.post('/startups', { title: 'Once' }, headers);
    const again = await f.post('/startups', { title: 'Once' }, headers);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(briefStore.records.size).toBe(1);
  });

  it('rejects the same key with a different body (409 IDEMPOTENCY_CONFLICT)', async () => {
    const f = await as('founder@test.example');
    const headers = key();
    await f.post('/startups', { title: 'One' }, headers);
    const res = await f.post('/startups', { title: 'Two' }, headers);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('scopes keys per actor: another founder may reuse a key', async () => {
    const headers = key();
    const a = await as('founder@test.example');
    const b = await as('founder2@test.example');
    const ra = await a.post('/startups', { title: 'Same' }, headers);
    const rb = await b.post('/startups', { title: 'Same' }, headers);
    expect(rb.status).toBe(201);
    expect(rb.body.data.id).not.toBe(ra.body.data.id);
  });

  it('frees the key after a failed attempt so the corrected request can use it', async () => {
    const f = await as('founder@test.example');
    const headers = key();
    expect((await f.post('/startups', { title: '' }, headers)).status).toBe(422);
    // Validation runs before reservation; a failure inside the operation also releases it.
    expect((await f.post('/startups', { title: 'Fixed' }, headers)).status).toBe(201);
  });

  it('releases the key when the operation itself fails (e.g. publish validation)', async () => {
    const f = await as('founder@test.example');
    const d = await createDraft(f);
    const headers = key();
    const first = await f.post(`/startups/${d.id}/publish`, { expectedVersion: 0 }, headers);
    expect(first.status).toBe(422);
    await f.patch(`/startups/${d.id}`, { expectedVersion: 0, changes: completeChanges() });
    const fixedBody = { expectedVersion: 1 };
    const second = await f.post(`/startups/${d.id}/publish`, fixedBody, headers);
    expect(second.status).toBe(200);
    expect(second.body.data.status).toBe('open');
  });

  it('completes an interrupted attempt with the reserved id instead of duplicating it', async () => {
    const f = await as('founder@test.example');
    const headers = key();
    const reservedId = MemoryBriefStore.newId();
    // Simulate a crash after reservation and before the insert.
    const { canonicalJson, sha256Hex } = await import('../src/lib/canonical-json.js');
    await idem.reserve({
      actorUserId: founder.id,
      route: 'POST /startups',
      key: headers['Idempotency-Key'].toLowerCase(),
      bodyHash: sha256Hex(canonicalJson({ title: 'Retried' })),
      resourceId: reservedId,
      responseStatus: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await f.post('/startups', { title: 'Retried' }, headers);
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe(reservedId);
    expect(briefStore.records.size).toBe(1);
  });

  it('treats an expired key as unused', async () => {
    const f = await as('founder@test.example');
    const headers = key();
    await f.post('/startups', { title: 'Old' }, headers);
    for (const r of idem.records.values()) r.expiresAt = new Date(Date.now() - 1);
    const res = await f.post('/startups', { title: 'New body' }, headers);
    expect(res.status).toBe(201);
    expect(res.body.data.title).toBe('New body');
    expect(await idem.purgeExpired(new Date(Date.now() + 25 * 3600_000))).toBe(1);
  });
});

describe('PATCH /startups/:id (draft edits)', () => {
  it('applies changes, increments the version and normalises text and skill aliases', async () => {
    const f = await as('founder@test.example');
    const d = await createDraft(f);
    const res = await f.patch(`/startups/${d.id}`, {
      expectedVersion: 0,
      changes: {
        teaser: '  Ｆｕｌｌ-width teaser  ',
        requiredSkills: [{ skillId: 'Node.js', level: 4, importance: 2, mandatory: false }],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(1);
    expect(res.body.data.teaser).toBe('Full-width teaser');
    expect(res.body.data.requiredSkills[0].skillId).toBe('nodejs');
    const again = await f.patch(`/startups/${d.id}`, {
      expectedVersion: 1,
      changes: { title: 'T2' },
    });
    expect(again.body.data.version).toBe(2);
    expect(again.body.data.teaser).toBe('Full-width teaser');
  });

  it('allows short draft text but enforces maximums, ranges, enums and duplicates', async () => {
    const f = await as('founder@test.example');
    const d = await createDraft(f);
    const ok = await f.patch(`/startups/${d.id}`, {
      expectedVersion: 0,
      changes: { teaser: 'short' },
    });
    expect(ok.status).toBe(200);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ teaser: 'x'.repeat(501) }, 'body.changes.teaser'],
      [{ problem: 'x'.repeat(3001) }, 'body.changes.problem'],
      [{ hoursRequiredPerWeek: 41 }, 'body.changes.hoursRequiredPerWeek'],
      [{ commitmentMonths: 0 }, 'body.changes.commitmentMonths'],
      [{ hoursRequiredPerWeek: 2.5 }, 'body.changes.hoursRequiredPerWeek'],
      [{ industryTags: ['space'] }, 'body.changes.industryTags.0'],
      [{ missionTags: ['privacy', 'privacy'] }, 'body.changes.missionTags'],
      [
        { requiredSkills: [{ skillId: 'cobol', level: 3, importance: 3, mandatory: false }] },
        'body.changes.requiredSkills.0.skillId',
      ],
      [
        {
          requiredSkills: [
            { skillId: 'nodejs', level: 3, importance: 3, mandatory: false },
            { skillId: 'node', level: 2, importance: 1, mandatory: true },
          ],
        },
        'body.changes.requiredSkills',
      ],
      [
        { requiredSkills: [{ skillId: 'git', level: 0, importance: 3, mandatory: false }] },
        'body.changes.requiredSkills.0.level',
      ],
      [{ teamSkills: [{ skillId: 'git', level: 6 }] }, 'body.changes.teamSkills.0.level'],
      [
        {
          requiredSkills: Array.from({ length: 9 }, (_, i) => ({
            skillId: [
              'nodejs',
              'javascript',
              'typescript',
              'rest-api',
              'authentication',
              'mongodb',
              'sql',
              'testing',
              'git',
            ][i],
            level: 3,
            importance: 3,
            mandatory: false,
          })),
        },
        'body.changes.requiredSkills',
      ],
      [
        {
          compensation: {
            type: 'equity',
            amountMinor: null,
            paymentDueDays: null,
            methodNote: '',
            benefitDescription: '',
          },
        },
        'body.changes.compensation.type',
      ],
      [
        {
          compensation: {
            type: 'paid',
            amountMinor: 10.5,
            paymentDueDays: 7,
            methodNote: '',
            benefitDescription: '',
          },
        },
        'body.changes.compensation.amountMinor',
      ],
      [
        {
          compensation: {
            type: 'paid',
            amountMinor: 100,
            paymentDueDays: 31,
            methodNote: '',
            benefitDescription: '',
          },
        },
        'body.changes.compensation.paymentDueDays',
      ],
      [{ compensation: { type: 'unpaid', currency: 'USD' } }, 'body.changes.compensation.currency'],
      [{ status: 'open' }, 'body.changes.status'],
    ];
    for (const [changes, field] of cases) {
      const res = await f.patch(`/startups/${d.id}`, { expectedVersion: 1, changes });
      expect(res.status, JSON.stringify(changes)).toBe(422);
      expect(Object.keys(res.body.error.fieldErrors), JSON.stringify(changes)).toContain(field);
    }
    const empty = await f.patch(`/startups/${d.id}`, { expectedVersion: 1, changes: {} });
    expect(empty.status).toBe(422);
    expect(briefStore.records.get(d.id)?.version).toBe(1);
  });

  it('returns 409 VERSION_CONFLICT for a stale version', async () => {
    const f = await as('founder@test.example');
    const d = await createDraft(f);
    await f.patch(`/startups/${d.id}`, { expectedVersion: 0, changes: { teaser: 'tab one' } });
    const stale = await f.patch(`/startups/${d.id}`, {
      expectedVersion: 0,
      changes: { teaser: 'tab two' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(briefStore.records.get(d.id)?.teaser).toBe('tab one');
  });

  it('hides other founders’ drafts (404) and refuses non-founders (403)', async () => {
    const f = await as('founder@test.example');
    const d = await createDraft(f);
    const other = await as('founder2@test.example');
    const res = await other.patch(`/startups/${d.id}`, {
      expectedVersion: 0,
      changes: { title: 'Mine' },
    });
    expect(res.status).toBe(404);
    expect((await other.get(`/startups/${d.id}`)).status).toBe(404);
    const c = await as('cand@test.example');
    expect(
      (await c.patch(`/startups/${d.id}`, { expectedVersion: 0, changes: { title: 'x' } })).status,
    ).toBe(403);
    expect(
      (await f.patch('/startups/not-an-id', { expectedVersion: 0, changes: { title: 'x' } }))
        .status,
    ).toBe(404);
    expect(briefStore.records.get(d.id)?.title).toBe('Webhook worker');
  });
});

describe('POST /startups/:id/publish', () => {
  it('lists every missing field before publishing', async () => {
    const f = await as('founder@test.example');
    const d = await createDraft(f);
    const res = await f.post(`/startups/${d.id}/publish`, { expectedVersion: 0 }, key());
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.error.fieldErrors).sort()).toEqual(
      [
        'brief.commitmentMonths',
        'brief.compensation.amountMinor',
        'brief.compensation.methodNote',
        'brief.compensation.paymentDueDays',
        'brief.hoursRequiredPerWeek',
        'brief.industryTags',
        'brief.missionTags',
        'brief.problem',
        'brief.requiredSkills',
        'brief.solution',
        'brief.teaser',
      ].sort(),
    );
    expect(briefStore.records.get(d.id)?.status).toBe('draft');
  });

  it('enforces publish-time minimum lengths', async () => {
    const f = await as('founder@test.example');
    const d = await createDraft(f);
    await f.patch(`/startups/${d.id}`, {
      expectedVersion: 0,
      changes: completeChanges({ teaser: 'x'.repeat(49) }),
    });
    const res = await f.post(`/startups/${d.id}/publish`, { expectedVersion: 1 }, key());
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.error.fieldErrors)).toEqual(['brief.teaser']);
  });

  it('requires a skill gap (422 NO_SKILL_GAP)', async () => {
    const f = await as('founder@test.example');
    const d = await createDraft(f);
    await f.patch(`/startups/${d.id}`, {
      expectedVersion: 0,
      changes: completeChanges({
        teamSkills: [
          { skillId: 'nodejs', level: 4 },
          { skillId: 'rest-api', level: 5 },
        ],
      }),
    });
    const res = await f.post(`/startups/${d.id}/publish`, { expectedVersion: 1 }, key());
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_SKILL_GAP');
  });

  it('publishes as open version 1 and then refuses edits', async () => {
    const f = await as('founder@test.example');
    const d = await createDraft(f);
    await f.patch(`/startups/${d.id}`, { expectedVersion: 0, changes: completeChanges() });
    const stale = await f.post(`/startups/${d.id}/publish`, { expectedVersion: 0 }, key());
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const res = await f.post(`/startups/${d.id}/publish`, { expectedVersion: 1 }, key());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'open', version: 1 });
    expect(res.body.data.publishedAt).toEqual(expect.any(String));
    expect(briefStore.records.get(d.id)?.transitionRevision).toBe(1);
    const edit = await f.patch(`/startups/${d.id}`, {
      expectedVersion: 1,
      changes: { title: 'New' },
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('INVALID_STATE');
    // Repeating the transition returns the existing resource.
    const repeat = await f.post(`/startups/${d.id}/publish`, { expectedVersion: 1 }, key());
    expect(repeat.status).toBe(200);
    expect(repeat.body.data.version).toBe(1);
  });

  it('clears compensation fields that do not belong to the chosen type', async () => {
    const f = await as('founder@test.example');
    const d = await createDraft(f);
    await f.patch(`/startups/${d.id}`, {
      expectedVersion: 0,
      changes: completeChanges({
        compensation: {
          type: 'credit_reference',
          amountMinor: 5000,
          paymentDueDays: 3,
          methodNote: 'left over',
          benefitDescription: 'A written reference and credit in our changelog.',
        },
      }),
    });
    const res = await f.post(`/startups/${d.id}/publish`, { expectedVersion: 1 }, key());
    expect(res.status).toBe(200);
    expect(res.body.data.compensation).toEqual({
      type: 'credit_reference',
      amountMinor: null,
      paymentDueDays: null,
      methodNote: '',
      benefitDescription: 'A written reference and credit in our changelog.',
    });
  });
});

describe('close and clone', () => {
  it('closes an open brief once, with a reason, and never reopens it', async () => {
    const f = await as('founder@test.example');
    const b = await publishedBrief(f);
    const tooLong = await f.post(`/startups/${b.id}/close`, { reason: 'x'.repeat(501) }, key());
    expect(tooLong.status).toBe(422);
    const res = await f.post(`/startups/${b.id}/close`, { reason: 'Found someone' }, key());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'closed', closeReason: 'Found someone' });
    expect((await f.post(`/startups/${b.id}/close`, { reason: '' }, key())).status).toBe(200);
    const publish = await f.post(`/startups/${b.id}/publish`, { expectedVersion: 1 }, key());
    expect(publish.status).toBe(409);
    expect(publish.body.error.code).toBe('INVALID_STATE');
    expect(briefStore.records.get(b.id)?.transitionRevision).toBe(2);
  });

  it('refuses to close a draft', async () => {
    const f = await as('founder@test.example');
    const d = await createDraft(f);
    const res = await f.post(`/startups/${d.id}/close`, { reason: '' }, key());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
  });

  it('clones into a new version-0 draft and leaves the original unchanged', async () => {
    const f = await as('founder@test.example');
    const b = await publishedBrief(f);
    const res = await f.post(`/startups/${b.id}/clone`, {}, key());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'draft',
      version: 0,
      clonedFromId: b.id,
      publishedAt: null,
      teaser: completeChanges().teaser,
    });
    expect(res.body.data.id).not.toBe(b.id);
    expect(briefStore.records.get(b.id)?.status).toBe('open');
    expect((await f.post(`/startups/${b.id}/clone`, { extra: 1 }, key())).status).toBe(422);
    const other = await as('founder2@test.example');
    expect((await other.post(`/startups/${b.id}/clone`, {}, key())).status).toBe(404);
  });
});

describe('visibility and confidentiality', () => {
  const CONFIDENTIAL = [
    'problem',
    'solution',
    'teamSkills',
    'founderUserId',
    'closeReason',
    'transitionRevision',
  ];

  it('gives the owner the full brief plus the preview', async () => {
    const f = await as('founder@test.example');
    const b = await publishedBrief(f);
    const res = await f.get(`/startups/${b.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.access).toBe('owner');
    expect(res.body.data.brief.problem).toMatch(/^Problem:/);
    expect(res.body.data.preview.title).toBe('Webhook worker');
  });

  it('shows candidates in the cohort only the teaser projection of an open brief', async () => {
    const f = await as('founder@test.example');
    const b = await publishedBrief(f);
    const c = await as('cand@test.example');
    const res = await c.get(`/startups/${b.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.access).toBe('preview');
    const preview = res.body.data.preview;
    for (const field of CONFIDENTIAL) expect(preview).not.toHaveProperty(field);
    expect(JSON.stringify(res.body)).not.toContain('Problem:');
    expect(JSON.stringify(res.body)).not.toContain('Solution:');
    expect(JSON.stringify(res.body)).not.toContain('founder@test.example');
    expect(preview).toMatchObject({
      title: 'Webhook worker',
      hoursRequiredPerWeek: 8,
      commitmentMonths: 3,
      trialCapHours: 10,
      ipPolicyVersion: 'creator-owned-v3.0',
      compensation: { type: 'paid', amountMinor: 200_000, currency: 'INR', payer: 'founder' },
      founder: { displayName: 'founder', demoAccount: true, completedSprintCount: 0 },
    });
  });

  it('returns 404 for drafts, closed briefs, other cohorts, moderators, other founders and suspended founders', async () => {
    const f = await as('founder@test.example');
    const draft = await createDraft(f);
    const open = await publishedBrief(f);
    const c = await as('cand@test.example');
    expect((await c.get(`/startups/${draft.id}`)).status).toBe(404);
    for (const email of ['elsewhere@test.example', 'mod@test.example', 'founder2@test.example']) {
      const viewer = await as(email);
      const res = await viewer.get(`/startups/${open.id}`);
      expect(res.status, email).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('Webhook');
    }
    ids.users.get(founder.id)!.status = 'suspended';
    expect((await c.get(`/startups/${open.id}`)).status).toBe(404);
    ids.users.get(founder.id)!.status = 'active';
    ids.users.get(founder.id)!.roles = ['candidate'];
    expect((await c.get(`/startups/${open.id}`)).status).toBe(404);
    ids.users.get(founder.id)!.roles = ['founder'];
    await f.post(`/startups/${open.id}/close`, { reason: '' }, key());
    expect((await c.get(`/startups/${open.id}`)).status).toBe(404);
    expect((await c.get('/startups/123')).status).toBe(404);
  });

  it('requires a session for every brief route', async () => {
    const anon = new TestClient(h.app);
    expect((await anon.get('/startups?scope=mine')).status).toBe(401);
    expect((await anon.get(`/startups/${MemoryBriefStore.newId()}`)).status).toBe(401);
    expect((await anon.post('/startups', { title: 'x' }, key())).status).toBe(401);
  });
});

describe('GET /startups (lists)', () => {
  it('lists the founder’s own briefs newest first with an opaque cursor', async () => {
    const f = await as('founder@test.example');
    const a = await createDraft(f, { title: 'A' });
    const b = await createDraft(f, { title: 'B' });
    const c = await createDraft(f, { title: 'C' });
    const other = await as('founder2@test.example');
    await createDraft(other, { title: 'Not mine' });
    const page1 = await f.get('/startups?scope=mine&limit=2');
    expect(page1.status).toBe(200);
    expect(page1.body.data.map((x: { id: string }) => x.id)).toEqual([c.id, b.id]);
    expect(page1.body.data[0]).not.toHaveProperty('problem');
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    const page2 = await f.get(`/startups?scope=mine&limit=2&cursor=${page1.body.nextCursor}`);
    expect(page2.body.data.map((x: { id: string }) => x.id)).toEqual([a.id]);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('validates scope, limit and cursor, and checks the role for each scope', async () => {
    const f = await as('founder@test.example');
    expect((await f.get('/startups')).status).toBe(422);
    expect((await f.get('/startups?scope=all')).status).toBe(422);
    expect((await f.get('/startups?scope=mine&limit=51')).status).toBe(422);
    expect((await f.get('/startups?scope=mine&cursor=garbage')).status).toBe(422);
    expect((await f.get('/startups?scope=mine&sort=title')).status).toBe(422);
    expect((await f.get('/startups?scope=discover')).status).toBe(403);
    const c = await as('cand@test.example');
    expect((await c.get('/startups?scope=mine')).status).toBe(403);
  });

  it('discovers only open briefs from active founders in the candidate’s cohort', async () => {
    const f = await as('founder@test.example');
    const open = await publishedBrief(f);
    await createDraft(f, { title: 'Hidden draft' });
    const closed = await publishedBrief(f);
    await f.post(`/startups/${closed.id}/close`, { reason: '' }, key());
    const dual = await as('dual@test.example');
    await publishedBrief(dual);

    const c = await as('cand@test.example');
    const res = await c.get('/startups?scope=discover');
    expect(res.status).toBe(200);
    const listed = res.body.data.map((x: { id: string }) => x.id);
    expect(listed).toHaveLength(2);
    expect(listed).toContain(open.id);
    expect(JSON.stringify(res.body)).not.toContain('Problem:');
    // A founder-candidate never discovers their own briefs (no self-pairing).
    const own = await dual.get('/startups?scope=discover');
    expect(own.body.data.map((x: { id: string }) => x.id)).toEqual([open.id]);
    const elsewhere = await as('elsewhere@test.example');
    expect((await elsewhere.get('/startups?scope=discover')).body.data).toEqual([]);
  });
});
