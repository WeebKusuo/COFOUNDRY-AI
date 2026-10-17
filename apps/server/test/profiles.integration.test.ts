import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { PROFILE_DISCLOSURE_POLICY_VERSION } from '@cofoundry/shared';
import { identityModels } from '../src/auth/models.js';
import { createMongoIdentityStore } from '../src/auth/store.js';
import { DEMO_ACCOUNTS, DEMO_CANDIDATE_PROFILES } from '../src/db/demo-accounts.js';
import { runMigrations } from '../src/db/migrations.js';
import { seedDemoAccounts } from '../src/db/seed.js';
import { profileModels } from '../src/profiles/models.js';
import { createMongoProfileStore, type ProfileStore } from '../src/profiles/store.js';
import { silentLogger } from './helpers.js';
import { openTestDb, type TestDb } from './support/db.js';
import { TestClient, buildHarness, type Harness } from './support/harness.js';

/** Profiles against a real database: Mongo store, indexes, fixture seeding and HTTP flows. */

const PASSWORD = 'demo-password-for-tests';
const email = (local: string) => DEMO_ACCOUNTS.find((a) => a.email.startsWith(`${local}@`))!.email;

let db: TestDb;
let h: Harness;
let store: ProfileStore;

async function userId(local: string): Promise<string> {
  const { User } = identityModels(db.conn);
  const u = await User.findOne({ emailLower: email(local) })
    .lean()
    .exec();
  return u!._id.toHexString();
}

beforeAll(async () => {
  db = await openTestDb('profiles');
  await runMigrations(db.conn, silentLogger);
  await seedDemoAccounts(db.conn, silentLogger, { demoMode: true, password: PASSWORD });
  store = createMongoProfileStore(db.conn);
  h = buildHarness({ store: createMongoIdentityStore(db.conn), profileStore: store });
});

afterAll(async () => {
  await db?.close();
});

describe('seeded Section 26 fixture profiles', () => {
  it('creates one revision-1 profile per demo candidate and the founder', async () => {
    const { CandidateProfile, FounderProfile } = profileModels(db.conn);
    expect(await CandidateProfile.countDocuments()).toBe(7);
    expect(await FounderProfile.countDocuments()).toBe(1);
    const asha = await store.findCandidate(await userId('asha'));
    expect(asha).toMatchObject({
      revision: 1,
      skills: [
        { skillId: 'nodejs', level: 4 },
        { skillId: 'rest-api', level: 3 },
      ],
      availableHoursPerWeek: 10,
      commitmentMonths: 3,
      industryTags: ['fintech'],
      missionTags: ['reliability', 'automation'],
      discoveryEnabled: true,
    });
    expect((await store.findCandidate(await userId('isha')))?.projects).toEqual([]);
    expect((await store.findCandidate(await userId('kabir')))?.availableHoursPerWeek).toBe(6);
    expect((await store.findCandidate(await userId('nila')))?.commitmentMonths).toBe(2);
    expect((await store.findCandidate(await userId('hidden')))?.discoveryEnabled).toBe(false);
  });

  it('records disclosure consent for the discoverable fixtures only', async () => {
    const { ConsentRecord } = profileModels(db.conn);
    const discoverable = Object.values(DEMO_CANDIDATE_PROFILES).filter(
      (p) => p.discoverable,
    ).length;
    expect(await ConsentRecord.countDocuments({ withdrawnAt: null })).toBe(discoverable);
    const hidden = await userId('hidden');
    expect(
      await store.hasActiveConsent({
        userId: hidden,
        purpose: 'profile_discovery',
        targetId: hidden,
      }),
    ).toBe(false);
  });

  it('does not overwrite profiles on a re-run of the seed', async () => {
    const dev = await userId('dev');
    const before = await store.findCandidate(dev);
    const summary = await seedDemoAccounts(db.conn, silentLogger, {
      demoMode: true,
      password: PASSWORD,
    });
    expect(summary.profilesCreated).toBe(0);
    expect(await store.findCandidate(dev)).toEqual(before);
  });
});

describe('Mongo profile store', () => {
  it('enforces one profile per user and optimistic revisions', async () => {
    const asha = await userId('asha');
    const current = await store.findCandidate(asha);
    const { userId: _u, revision: _r, updatedAt: _t, ...fields } = current!;
    expect(await store.saveCandidate(asha, 0, fields)).toBe('conflict');
    expect(await store.saveCandidate(asha, 7, fields)).toBe('conflict');
    const saved = await store.saveCandidate(asha, 1, { ...fields, headline: 'Updated' });
    expect(saved).toMatchObject({ revision: 2, headline: 'Updated' });
    expect(await store.saveCandidate(asha, 1, fields)).toBe('conflict');
  });

  it('keeps one active consent per user/purpose/target and the withdrawn history', async () => {
    const id = new mongoose.Types.ObjectId().toHexString();
    const key = { userId: id, purpose: 'profile_discovery' as const, targetId: id };
    await Promise.all(
      [1, 2, 3].map(() => store.grantConsent(key, PROFILE_DISCLOSURE_POLICY_VERSION, new Date())),
    );
    const { ConsentRecord } = profileModels(db.conn);
    const oid = new mongoose.Types.ObjectId(id);
    expect(await ConsentRecord.countDocuments({ userId: oid, withdrawnAt: null })).toBe(1);
    expect(await store.withdrawConsent(key, new Date())).toBe(1);
    expect(await store.hasActiveConsent(key)).toBe(false);
    await store.grantConsent(key, PROFILE_DISCLOSURE_POLICY_VERSION, new Date());
    expect(await ConsentRecord.countDocuments({ userId: oid })).toBe(2);
    expect(await store.hasActiveConsent(key)).toBe(true);
  });

  it('rejects a second profile document for the same user at the index level', async () => {
    const { FounderProfile } = profileModels(db.conn);
    const founder = await userId('founder');
    await expect(
      FounderProfile.create({ userId: new mongoose.Types.ObjectId(founder), revision: 1, bio: '' }),
    ).rejects.toThrow(/duplicate key|E11000/i);
  });
});

describe('HTTP flows on MongoDB', () => {
  it('a seeded candidate edits a project, and the change persists', async () => {
    const c = new TestClient(h.app);
    expect((await c.login(email('dev'), PASSWORD)).status).toBe(200);
    const profile = (await c.get('/candidate/profile')).body.data;
    expect(profile).toMatchObject({ revision: 1, discoveryEnabled: true, discoveryConsent: true });
    const [project] = profile.projects;
    const res = await c.put('/candidate/profile', {
      expectedRevision: 1,
      headline: profile.headline,
      bio: profile.bio,
      skills: profile.skills,
      industryTags: profile.industryTags,
      missionTags: profile.missionTags,
      availableHoursPerWeek: profile.availableHoursPerWeek,
      commitmentMonths: profile.commitmentMonths,
      opportunityTypes: profile.opportunityTypes,
      projects: [
        {
          id: project.id,
          title: project.title,
          description: project.description,
          skillTags: project.skillTags,
          url: 'https://github.com/dev/invoices',
        },
      ],
      discoveryEnabled: true,
      discoveryConsent: true,
    });
    expect(res.status).toBe(200);
    const again = (await c.get('/candidate/profile')).body.data;
    expect(again.revision).toBe(2);
    expect(again.projects[0]).toMatchObject({ id: project.id, evidenceStatus: 'project_linked' });
  });

  it('shows discoverable fixtures to the founder and hides the hidden candidate', async () => {
    const f = new TestClient(h.app);
    await f.login(email('founder'), PASSWORD);
    const nila = await f.get(`/profiles/${await userId('nila')}`);
    expect(nila.status).toBe(200);
    expect(nila.body.data.displayName).toBe('Nila');
    expect(JSON.stringify(nila.body)).not.toContain('@demo.cofoundry.test');
    expect((await f.get(`/profiles/${await userId('hidden')}`)).status).toBe(404);
  });

  it('turning discovery off and withdrawing consent hides the profile immediately', async () => {
    const c = new TestClient(h.app);
    await c.login(email('mira'), PASSWORD);
    const p = (await c.get('/candidate/profile')).body.data;
    const off = await c.put('/candidate/profile', {
      expectedRevision: p.revision,
      headline: p.headline,
      bio: p.bio,
      skills: p.skills,
      industryTags: p.industryTags,
      missionTags: p.missionTags,
      availableHoursPerWeek: p.availableHoursPerWeek,
      commitmentMonths: p.commitmentMonths,
      opportunityTypes: p.opportunityTypes,
      projects: p.projects.map(
        ({ id, title, description, skillTags, url }: Record<string, unknown>) => ({
          id,
          title,
          description,
          skillTags,
          url,
        }),
      ),
      discoveryEnabled: false,
      discoveryConsent: false,
    });
    expect(off.status).toBe(200);
    const f = new TestClient(h.app);
    await f.login(email('founder'), PASSWORD);
    expect((await f.get(`/profiles/${await userId('mira')}`)).status).toBe(404);
    const { ConsentRecord } = profileModels(db.conn);
    const mira = new mongoose.Types.ObjectId(await userId('mira'));
    const record = await ConsentRecord.findOne({ userId: mira }).lean().exec();
    expect(record?.withdrawnAt).toBeInstanceOf(Date);
    expect(record?.activeKey).toBeUndefined();
  });

  it('--reset removes and recreates demo profiles and consents', async () => {
    const summary = await seedDemoAccounts(db.conn, silentLogger, {
      demoMode: true,
      password: PASSWORD,
      reset: true,
    });
    expect(summary.profilesCreated).toBe(8);
    const asha = await store.findCandidate(await userId('asha'));
    expect(asha?.revision).toBe(1);
    expect(asha?.headline).not.toBe('Updated');
  });
});
