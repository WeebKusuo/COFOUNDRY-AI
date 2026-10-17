import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PROFILE_DISCLOSURE_POLICY_VERSION,
  RESUME_POLICY_VERSION,
  type RecommendationSearchResponse,
} from '@cofoundry/shared';
import { DEMO_ACCOUNTS, DEMO_BRIEFS, DEMO_CANDIDATE_PROFILES } from '../src/db/demo-accounts.js';
import { createRateLimiter } from '../src/http/middleware/rate-limit.js';
import type { UserRecord } from '../src/auth/store.js';
import type { BlockPolicy } from '../src/safety/blocks.js';
import { MemoryIdentityStore } from './support/memory-store.js';
import { MemoryProfileStore } from './support/memory-profile-store.js';
import { MemoryBriefStore } from './support/memory-brief-store.js';
import { MemoryRecommendationStore } from './support/memory-recommendation-store.js';
import { TestClient, addTestUser, buildHarness, type Harness } from './support/harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let ids: MemoryIdentityStore;
let pstore: MemoryProfileStore;
let briefStore: MemoryBriefStore;
let batches: MemoryRecommendationStore;
let h: Harness;
let clock: Date;
let blocked: Set<string>;
const users: Record<string, UserRecord> = {};
let briefId: string;

const blocks: BlockPolicy = {
  async blockedAmong(_userId, others) {
    return new Set(others.filter((o) => blocked.has(o)));
  },
};

/** Section 26 candidates and the PayPilot brief, from the real seed fixtures. */
async function seedFixture() {
  for (const account of DEMO_ACCOUNTS) {
    const local = account.email.split('@')[0]!;
    // Fixed ids keep candidate-id tie-breaks deterministic.
    users[local] = await addTestUser(ids, account.email, account.roles, {
      displayName: account.displayName,
      cohortId: 'demo-v3.0',
    });
    const fixture = DEMO_CANDIDATE_PROFILES[account.seedKey];
    if (!fixture) continue;
    const u = users[local]!;
    pstore.candidates.set(u.id, {
      userId: u.id,
      revision: 1,
      headline: fixture.headline,
      bio: fixture.bio,
      skills: fixture.skills,
      industryTags: fixture.industryTags,
      missionTags: fixture.missionTags,
      availableHoursPerWeek: fixture.availableHoursPerWeek,
      commitmentMonths: fixture.commitmentMonths,
      opportunityTypes: ['contributor'],
      projects: fixture.projects.map((p, i) => ({
        id: `${u.id.slice(0, 22)}${String(i).padStart(2, '0')}`,
        ...p,
        evidenceStatus: p.url ? 'project_linked' : 'self_reported',
      })),
      discoveryEnabled: fixture.discoverable,
      updatedAt: new Date(),
    });
    if (fixture.discoverable) {
      await pstore.grantConsent(
        { userId: u.id, purpose: 'profile_discovery', targetId: u.id },
        PROFILE_DISCLOSURE_POLICY_VERSION,
        new Date(),
      );
    }
  }
  const founder = users.founder!;
  const { record } = await briefStore.insertDraft({
    id: MemoryBriefStore.newId(),
    founderUserId: founder.id,
    fields: DEMO_BRIEFS[0]!.fields,
    clonedFromId: null,
  });
  await briefStore.publish(
    record.id,
    founder.id,
    0,
    { compensation: record.compensation },
    new Date(),
  );
  briefId = record.id;
}

beforeEach(async () => {
  ids = new MemoryIdentityStore();
  pstore = new MemoryProfileStore();
  briefStore = new MemoryBriefStore();
  batches = new MemoryRecommendationStore();
  clock = new Date('2026-10-17T10:00:00.000Z');
  blocked = new Set();
  await seedFixture();
  h = buildHarness({
    store: ids,
    profileStore: pstore,
    briefStore,
    recommendationStore: batches,
    blocks,
    now: () => clock,
  });
});

async function as(local: string) {
  const client = new TestClient(h.app);
  expect((await client.login(users[local]!.emailLower)).status).toBe(200);
  return client;
}

const key = () => ({ 'Idempotency-Key': randomUUID() });
const names = (list: Array<{ profile: { displayName: string } }>) =>
  list.map((e) => e.profile.displayName);

async function search(c: TestClient, headers = key()) {
  const res = await c.post(`/startups/${briefId}/recommendations`, {}, headers);
  return res as typeof res & { body: { data: RecommendationSearchResponse } };
}

describe('POST /startups/:id/recommendations', () => {
  it('produces the Section 26 groups, exact scores and gate counts (MAT-01)', async () => {
    const f = await as('founder');
    const res = await search(f);
    expect(res.status).toBe(201);
    const data = res.body.data;
    expect(data.algorithmVersion).toBe('match-v3.0');
    expect(names(data.recommendations)).toEqual(['Asha', 'Dev']);
    expect(names(data.provisional)).toEqual(['Isha']);
    expect(names(data.nearMatches)).toEqual(['Nila']);
    expect(data.recommendations[0]!.score).toBe(100);
    expect(data.recommendations[1]!.score).toBeCloseTo(73.392857, 6);
    expect(data.provisional[0]!).toMatchObject({
      score: 100,
      coverageWeight: 0.8,
      provisional: true,
    });
    expect(data.nearMatches[0]!.score).toBeCloseTo(96.666667, 6);
    expect(data.exclusions).toEqual({
      totalExcluded: 2,
      gates: [
        { code: 'opportunity_type', count: 0 },
        { code: 'essential_skill', count: 1 },
        { code: 'minimum_hours', count: 1 },
        { code: 'minimum_commitment', count: 0 },
      ],
    });
    expect(new Date(data.expiresAt).getTime() - new Date(data.generatedAt).getTime()).toBe(
      15 * 60_000,
    );
    // Hidden appears nowhere, not even in counts; Kabir and Mira are only counted.
    const json = JSON.stringify(res.body);
    for (const absent of ['Hidden', 'Kabir', 'Mira']) expect(json).not.toContain(absent);
  });

  it('persists only computed results and revisions, never profile text', async () => {
    const f = await as('founder');
    const res = await search(f);
    const stored = batches.batches.get(res.body.data.batchId)!;
    expect(stored).toMatchObject({ briefId, briefVersion: 1, founderUserId: users.founder!.id });
    expect(stored.entries).toHaveLength(4);
    expect(stored.entries[0]).toHaveProperty('profileRevision', 1);
    const json = JSON.stringify(stored);
    expect(json).not.toContain(DEMO_CANDIDATE_PROFILES['demo:candidate:asha']!.headline);
    expect(json).not.toContain('Asha');
  });

  it('returns privacy-safe profiles: no email, consent, account or resume data', async () => {
    const asha = await as('asha');
    const pdf = fs.readFileSync(path.join(here, 'fixtures', 'resumes', 'resume-text.pdf'));
    expect(
      (
        await asha.upload('/candidate/resume', pdf, {
          'Content-Type': 'application/pdf',
          'X-Resume-Consent': RESUME_POLICY_VERSION,
          'X-Expected-Version': '0',
          'X-Filename': 'asha-cv.pdf',
        })
      ).status,
    ).toBe(200);
    const f = await as('founder');
    const res = await search(f);
    const json = JSON.stringify(res.body);
    for (const leak of [
      '@demo.cofoundry.test',
      'asha-cv',
      'resume',
      'Riya',
      'discoveryConsent',
      'passwordHash',
      'cohortId',
      'status"',
    ]) {
      expect(json, leak).not.toContain(leak);
    }
    expect(Object.keys(res.body.data.recommendations[0]!.profile).sort()).toEqual(
      [
        'bio',
        'commitmentMonths',
        'availableHoursPerWeek',
        'demoAccount',
        'displayName',
        'headline',
        'industryTags',
        'missionTags',
        'projects',
        'skills',
      ].sort(),
    );
  });

  it('is owner-only, founder-only, idempotent and needs an open brief', async () => {
    const c = await as('asha');
    expect((await search(c)).status).toBe(403);
    const other = await addTestUser(ids, 'other-founder@test.example', ['founder'], {
      cohortId: 'demo-v3.0',
    });
    const o = new TestClient(h.app);
    await o.login(other.emailLower);
    expect((await search(o)).status).toBe(404);
    const f = await as('founder');
    expect((await f.post(`/startups/${briefId}/recommendations`, {})).status).toBe(400);
    expect((await f.post(`/startups/${briefId}/recommendations`, { limit: 5 }, key())).status).toBe(
      422,
    );
    expect((await f.post('/startups/nope/recommendations', {}, key())).status).toBe(404);
    const headers = key();
    const first = await search(f, headers);
    const again = await search(f, headers);
    expect(again.status).toBe(201);
    expect(again.body.data.batchId).toBe(first.body.data.batchId);
    expect(batches.batches.size).toBe(1);
    await briefStore.close(briefId, users.founder!.id, '', clock);
    const closed = await search(f);
    expect(closed.status).toBe(409);
    expect(closed.body.error.code).toBe('INVALID_STATE');
  });

  it('serialises duplicate concurrent requests by key and keeps distinct searches separate', async () => {
    const f = await as('founder');
    const headers = key();
    const [a, b] = await Promise.all([search(f, headers), search(f, headers)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.data.batchId).toBe(b.body.data.batchId);
    const [c, d] = await Promise.all([search(f), search(f)]);
    expect(c.body.data.batchId).not.toBe(d.body.data.batchId);
    expect(batches.batches.size).toBe(3);
  });

  it('excludes blocked, suspended, other-cohort, undiscoverable and self from results and counts', async () => {
    blocked.add(users.asha!.id);
    ids.users.get(users.dev!.id)!.status = 'suspended';
    ids.users.get(users.kabir!.id)!.cohortId = 'elsewhere';
    pstore.candidates.get(users.mira!.id)!.discoveryEnabled = false;
    // The founder also holds the candidate role and a discoverable profile: never self-matched.
    ids.users.get(users.founder!.id)!.roles = ['founder', 'candidate'];
    pstore.candidates.set(users.founder!.id, {
      ...pstore.candidates.get(users.isha!.id)!,
      userId: users.founder!.id,
    });
    await pstore.grantConsent(
      { userId: users.founder!.id, purpose: 'profile_discovery', targetId: users.founder!.id },
      'v',
      clock,
    );
    const f = await as('founder');
    const data = (await search(f)).body.data;
    expect(names([...data.recommendations, ...data.provisional, ...data.nearMatches])).toEqual([
      'Isha',
      'Nila',
    ]);
    expect(data.exclusions.totalExcluded).toBe(0);
  });

  it('requires an active discovery consent, not just the discovery flag', async () => {
    await pstore.withdrawConsent(
      { userId: users.asha!.id, purpose: 'profile_discovery', targetId: users.asha!.id },
      clock,
    );
    const f = await as('founder');
    expect(names((await search(f)).body.data.recommendations)).toEqual(['Dev']);
  });

  it('rate-limits searches per founder', async () => {
    h = buildHarness({
      store: ids,
      profileStore: pstore,
      briefStore,
      recommendationStore: batches,
      now: () => clock,
      searchLimiter: createRateLimiter({
        windowMs: 60_000,
        limit: 2,
        keyGenerator: (req) => `d:${req.auth?.user?.id}`,
      }),
    });
    const f = await as('founder');
    expect((await search(f)).status).toBe(201);
    expect((await search(f)).status).toBe(201);
    const limited = await search(f);
    expect(limited.status).toBe(429);
  });

  it('refuses an oversized cohort instead of sampling it (503 CAPACITY_LIMIT)', async () => {
    const template = pstore.candidates.get(users.asha!.id)!;
    const bulk: string[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const u = ids.addUser({
        ...users.asha!,
        id: undefined as unknown as string,
        emailLower: `bulk${i}@x.example`,
      });
      pstore.candidates.set(u.id, { ...template, userId: u.id });
      bulk.push(u.id);
    }
    const f = await as('founder');
    // Discovery on but no consent: these people are not discoverable and must not count.
    expect((await search(f)).status).toBe(201);
    for (const id of bulk) {
      await pstore.grantConsent(
        { userId: id, purpose: 'profile_discovery', targetId: id },
        'v',
        clock,
      );
    }
    const res = await search(f);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CAPACITY_LIMIT');
  });
});

describe('GET /startups/:id/recommendations (freshness and privacy re-checks)', () => {
  it('returns the latest batch, or 409 when there is none', async () => {
    const f = await as('founder');
    const none = await f.get(`/startups/${briefId}/recommendations`);
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('STALE_RECOMMENDATION');
    await search(f);
    clock = new Date(clock.getTime() + 1000);
    const second = await search(f);
    const res = await f.get(`/startups/${briefId}/recommendations`);
    expect(res.status).toBe(200);
    expect(res.body.data.batchId).toBe(second.body.data.batchId);
    expect((await f.get(`/startups/${briefId}/recommendations?refresh=1`)).status).toBe(422);
  });

  it('expires after 15 minutes (MAT-08)', async () => {
    const f = await as('founder');
    await search(f);
    clock = new Date(clock.getTime() + 15 * 60_000 - 1);
    expect((await f.get(`/startups/${briefId}/recommendations`)).status).toBe(200);
    clock = new Date(clock.getTime() + 1);
    const res = await f.get(`/startups/${briefId}/recommendations`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/expired/);
  });

  it('becomes stale when a listed candidate edits their profile', async () => {
    const f = await as('founder');
    await search(f);
    pstore.candidates.get(users.dev!.id)!.revision = 2;
    const res = await f.get(`/startups/${briefId}/recommendations`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/updated their profile/);
  });

  it('withholds candidates who withdrew consent, turned discovery off or were blocked, without refilling (MAT-07)', async () => {
    const f = await as('founder');
    const first = (await search(f)).body.data;
    await pstore.withdrawConsent(
      { userId: users.asha!.id, purpose: 'profile_discovery', targetId: users.asha!.id },
      clock,
    );
    pstore.candidates.get(users.isha!.id)!.discoveryEnabled = false;
    blocked.add(users.nila!.id);
    const res = await f.get(`/startups/${briefId}/recommendations`);
    expect(res.status).toBe(200);
    expect(names(res.body.data.recommendations)).toEqual(['Dev']);
    expect(res.body.data.provisional).toEqual([]);
    expect(res.body.data.nearMatches).toEqual([]);
    // Withheld silently: nothing in the response reveals that anyone disappeared.
    expect(res.body.data).not.toHaveProperty('withheldSinceGeneration');
    expect(res.body.data.batchId).toBe(first.batchId);
    expect(res.body.data.exclusions).toEqual(first.exclusions);
    expect(JSON.stringify(res.body)).not.toMatch(/Asha|Isha|Nila/);
  });

  it('becomes stale when the brief closes, and hides batches from other founders', async () => {
    const f = await as('founder');
    await search(f);
    const other = await addTestUser(ids, 'other-founder@test.example', ['founder'], {
      cohortId: 'demo-v3.0',
    });
    const o = new TestClient(h.app);
    await o.login(other.emailLower);
    expect((await o.get(`/startups/${briefId}/recommendations`)).status).toBe(404);
    expect((await (await as('asha')).get(`/startups/${briefId}/recommendations`)).status).toBe(403);
    await briefStore.close(briefId, users.founder!.id, '', clock);
    expect((await f.get(`/startups/${briefId}/recommendations`)).status).toBe(409);
  });

  it('removes personal entries after 24 hours and then treats the batch as stale', async () => {
    const f = await as('founder');
    const res = await search(f);
    clock = new Date(clock.getTime() + 24 * 3600_000 + 1);
    expect(await h.recommendations.purgeExpiredEntries()).toBe(1);
    const stored = batches.batches.get(res.body.data.batchId)!;
    expect(stored.entries).toEqual([]);
    expect(stored.entriesPurgedAt).toEqual(clock);
    expect((await f.get(`/startups/${briefId}/recommendations`)).status).toBe(409);
  });
});

describe('invitation boundary (prepared for the interview phase)', () => {
  it('accepts a listed, unchanged, still-eligible candidate from a fresh batch', async () => {
    const f = await as('founder');
    const batchId = (await search(f)).body.data.batchId;
    const ok = await h.recommendations.resolveForInvitation(users.founder!, {
      briefId,
      batchId,
      candidateUserId: users.dev!.id,
    });
    expect(ok).toMatchObject({
      profileRevision: 1,
      briefVersion: 1,
      entry: { group: 'recommendations' },
    });
  });

  it('refuses stale, unlisted, changed or expired cases with 409 STALE_RECOMMENDATION', async () => {
    const f = await as('founder');
    const batchId = (await search(f)).body.data.batchId;
    const attempt = (candidateUserId: string, id = batchId) =>
      h.recommendations.resolveForInvitation(users.founder!, {
        briefId,
        batchId: id,
        candidateUserId,
      });
    await expect(attempt(users.kabir!.id)).rejects.toMatchObject({ code: 'STALE_RECOMMENDATION' });
    await expect(attempt(users.dev!.id, MemoryBriefStore.newId())).rejects.toMatchObject({
      code: 'STALE_RECOMMENDATION',
    });
    pstore.candidates.get(users.dev!.id)!.revision = 2;
    await expect(attempt(users.dev!.id)).rejects.toMatchObject({ code: 'STALE_RECOMMENDATION' });
    clock = new Date(clock.getTime() + 15 * 60_000);
    await expect(attempt(users.asha!.id)).rejects.toMatchObject({ code: 'STALE_RECOMMENDATION' });
  });
});
