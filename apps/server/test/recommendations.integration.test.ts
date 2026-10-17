import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecommendationSearchResponse } from '@cofoundry/shared';
import { identityModels } from '../src/auth/models.js';
import { createMongoIdentityStore } from '../src/auth/store.js';
import { createMongoBriefStore, createMongoIdempotencyStore } from '../src/briefs/store.js';
import { DEMO_ACCOUNTS } from '../src/db/demo-accounts.js';
import { runMigrations } from '../src/db/migrations.js';
import { seedDemoAccounts } from '../src/db/seed.js';
import { createMongoProfileStore } from '../src/profiles/store.js';
import { recommendationModel } from '../src/recommendations/models.js';
import { createMongoRecommendationStore } from '../src/recommendations/store.js';
import { silentLogger } from './helpers.js';
import { openTestDb, type TestDb } from './support/db.js';
import { TestClient, buildHarness, type Harness } from './support/harness.js';

/** Matching and recommendation batches against a real database and the seeded fixtures. */

const PASSWORD = 'demo-password-for-tests';
const email = (local: string) => DEMO_ACCOUNTS.find((a) => a.email.startsWith(`${local}@`))!.email;

let db: TestDb;
let h: Harness;
let briefId: string;

beforeAll(async () => {
  db = await openTestDb('recommendations');
  await runMigrations(db.conn, silentLogger);
  await seedDemoAccounts(db.conn, silentLogger, { demoMode: true, password: PASSWORD });
  h = buildHarness({
    store: createMongoIdentityStore(db.conn),
    profileStore: createMongoProfileStore(db.conn),
    briefStore: createMongoBriefStore(db.conn),
    idempotencyStore: createMongoIdempotencyStore(db.conn),
    recommendationStore: createMongoRecommendationStore(db.conn),
  });
});

afterAll(async () => {
  await db?.close();
});

async function as(local: string) {
  const client = new TestClient(h.app);
  expect((await client.login(email(local), PASSWORD)).status).toBe(200);
  return client;
}

const names = (list: Array<{ profile: { displayName: string } }>) =>
  list.map((e) => e.profile.displayName);

describe('recommendations on MongoDB', () => {
  it('creates the batch index', async () => {
    const indexes = await db.conn.db!.collection('recommendation_batches').indexes();
    expect(indexes.map((i) => i.name)).toEqual(
      expect.arrayContaining(['briefId_generatedAt', 'generatedAt']),
    );
  });

  it('reproduces the Section 26 groups from the seeded data and stores the batch (MAT-01)', async () => {
    const f = await as('founder');
    const briefs = await f.get('/startups?scope=mine');
    briefId = briefs.body.data[0].id;
    const res = await f.post(
      `/startups/${briefId}/recommendations`,
      {},
      { 'Idempotency-Key': randomUUID() },
    );
    expect(res.status).toBe(201);
    const data = res.body.data as RecommendationSearchResponse;
    expect(names(data.recommendations)).toEqual(['Asha', 'Dev']);
    expect(names(data.provisional)).toEqual(['Isha']);
    expect(names(data.nearMatches)).toEqual(['Nila']);
    expect(data.recommendations[1]!.score).toBeCloseTo(73.392857, 6);
    expect(data.nearMatches[0]!.score).toBeCloseTo(96.666667, 6);
    expect(data.exclusions.totalExcluded).toBe(2);

    const stored = await recommendationModel(db.conn).findById(data.batchId).lean().exec();
    expect(stored).toMatchObject({
      briefVersion: 1,
      algorithmVersion: 'match-v3.0',
      totalExcluded: 2,
    });
    expect(stored!.entries).toHaveLength(4);
    expect(JSON.stringify(stored)).not.toMatch(/Asha|@demo|headline/);

    const latest = await f.get(`/startups/${briefId}/recommendations`);
    expect(latest.status).toBe(200);
    expect(latest.body.data.batchId).toBe(data.batchId);
  });

  it('invalidates the batch after a listed candidate saves their profile', async () => {
    const dev = await as('dev');
    const profile = (await dev.get('/candidate/profile')).body.data;
    const { userId: _u, revision, updatedAt: _t, ...fields } = profile;
    const saved = await dev.put('/candidate/profile', {
      ...fields,
      expectedRevision: revision,
      headline: 'Updated headline',
      projects: fields.projects.map((p: Record<string, unknown>) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        skillTags: p.skillTags,
        url: p.url,
      })),
    });
    expect(saved.status).toBe(200);
    const f = await as('founder');
    const res = await f.get(`/startups/${briefId}/recommendations`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STALE_RECOMMENDATION');
    // A new search uses the new revision.
    const fresh = await f.post(
      `/startups/${briefId}/recommendations`,
      {},
      { 'Idempotency-Key': randomUUID() },
    );
    expect(fresh.body.data.recommendations[1].profileRevision).toBe(2);
  });

  it('hides a candidate who turns discovery off, on the very next read', async () => {
    const asha = await as('asha');
    const profile = (await asha.get('/candidate/profile')).body.data;
    const { userId: _u, revision, updatedAt: _t, ...fields } = profile;
    await asha.put('/candidate/profile', {
      ...fields,
      expectedRevision: revision,
      discoveryEnabled: false,
      discoveryConsent: false,
      projects: fields.projects.map((p: Record<string, unknown>) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        skillTags: p.skillTags,
        url: p.url,
      })),
    });
    const f = await as('founder');
    const res = await f.get(`/startups/${briefId}/recommendations`);
    expect(res.status).toBe(200);
    expect(names(res.body.data.recommendations)).toEqual(['Dev']);
    expect(JSON.stringify(res.body)).not.toContain('Asha');
    const fresh = await f.post(
      `/startups/${briefId}/recommendations`,
      {},
      { 'Idempotency-Key': randomUUID() },
    );
    expect(JSON.stringify(fresh.body)).not.toContain('Asha');
    expect(fresh.body.data.exclusions.totalExcluded).toBe(2);
  });

  it('purges entries older than 24 hours', async () => {
    const Batch = recommendationModel(db.conn);
    await Batch.updateMany(
      {},
      { $set: { generatedAt: new Date(Date.now() - 25 * 3600_000) } },
    ).exec();
    expect(await h.recommendations.purgeExpiredEntries()).toBeGreaterThan(0);
    const remaining = await Batch.find({}).lean().exec();
    expect(remaining.every((b) => b.entries.length === 0 && b.entriesPurgedAt)).toBe(true);
  });

  it('seed --reset removes demo founders’ batches', async () => {
    await seedDemoAccounts(db.conn, silentLogger, {
      demoMode: true,
      password: PASSWORD,
      reset: true,
    });
    expect(await recommendationModel(db.conn).countDocuments()).toBe(0);
    expect(await identityModels(db.conn).User.countDocuments()).toBe(DEMO_ACCOUNTS.length);
  });
});
