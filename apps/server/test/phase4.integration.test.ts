import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { RESUME_POLICY_VERSION, briefPublishGaps, emptyBriefDraft } from '@cofoundry/shared';
import { identityModels } from '../src/auth/models.js';
import { createMongoIdentityStore } from '../src/auth/store.js';
import { briefModels } from '../src/briefs/models.js';
import { createMongoBriefStore, createMongoIdempotencyStore } from '../src/briefs/store.js';
import { DEMO_ACCOUNTS, DEMO_BRIEFS } from '../src/db/demo-accounts.js';
import { runMigrations } from '../src/db/migrations.js';
import { seedDemoAccounts } from '../src/db/seed.js';
import { createMongoProfileStore } from '../src/profiles/store.js';
import { resumeModel } from '../src/resumes/models.js';
import { createLocalFileStorage } from '../src/resumes/storage.js';
import { createMongoResumeStore } from '../src/resumes/store.js';
import { silentLogger } from './helpers.js';
import { openTestDb, type TestDb } from './support/db.js';
import { TestClient, buildHarness, type Harness } from './support/harness.js';

/** Briefs, idempotency and resumes against a real database and the real local file storage. */

const PASSWORD = 'demo-password-for-tests';
const here = path.dirname(fileURLToPath(import.meta.url));
const pdf = (name: string) =>
  fs.readFileSync(path.join(here, 'fixtures', 'resumes', `${name}.pdf`));
const email = (local: string) => DEMO_ACCOUNTS.find((a) => a.email.startsWith(`${local}@`))!.email;

let db: TestDb;
let h: Harness;
let storageDir: string;
const deletedFiles: string[] = [];

beforeAll(async () => {
  db = await openTestDb('phase4');
  await runMigrations(db.conn, silentLogger);
  await seedDemoAccounts(db.conn, silentLogger, { demoMode: true, password: PASSWORD });
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-resumes-'));
  const profileStore = createMongoProfileStore(db.conn);
  h = buildHarness({
    store: createMongoIdentityStore(db.conn),
    profileStore,
    briefStore: createMongoBriefStore(db.conn),
    idempotencyStore: createMongoIdempotencyStore(db.conn),
    resumeStore: createMongoResumeStore(db.conn),
    resumeFiles: createLocalFileStorage(storageDir),
  });
});

afterAll(async () => {
  await db?.close();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

async function as(local: string) {
  const client = new TestClient(h.app);
  expect((await client.login(email(local), PASSWORD)).status).toBe(200);
  return client;
}

const key = () => ({ 'Idempotency-Key': randomUUID() });

describe('migrations 4 and 5', () => {
  it('creates the brief, idempotency and resume indexes', async () => {
    const names = async (c: string) =>
      (await db.conn.db!.collection(c).indexes()).map((i) => i.name);
    expect(await names('startup_briefs')).toEqual(
      expect.arrayContaining([
        'founderUserId_status',
        'founderUserId_createdAt',
        'status_createdAt',
        'seedKey_unique',
      ]),
    );
    expect(await names('idempotency_records')).toEqual(
      expect.arrayContaining(['actor_route_key_unique', 'expiresAt']),
    );
    expect(await names('candidate_resumes')).toEqual(expect.arrayContaining(['userId_unique']));
  });

  it('enforces one idempotency record per actor, route and key', async () => {
    const { IdempotencyRecord } = briefModels(db.conn);
    const doc = {
      actorUserId: new mongoose.Types.ObjectId(),
      route: 'POST /startups',
      key: randomUUID(),
      bodyHash: 'h',
      resourceId: 'r',
      expiresAt: new Date(Date.now() + 1000),
    };
    await IdempotencyRecord.create(doc);
    await expect(IdempotencyRecord.create(doc)).rejects.toMatchObject({ code: 11000 });
    await expect(IdempotencyRecord.create({ ...doc, route: 'POST /other' })).resolves.toBeTruthy();
  });

  it('enforces one resume document per candidate', async () => {
    const Resume = resumeModel(db.conn);
    const userId = new mongoose.Types.ObjectId();
    await Resume.create({ userId, version: 1, current: null });
    await expect(Resume.create({ userId, version: 1, current: null })).rejects.toMatchObject({
      code: 11000,
    });
    await Resume.deleteMany({ userId });
  });
});

describe('Section 26 PayPilot brief seed', () => {
  it('publishes the fixture brief once with the contract values', async () => {
    const { StartupBrief } = briefModels(db.conn);
    const docs = await StartupBrief.find({ seedKey: 'demo:brief:paypilot' }).lean().exec();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      status: 'open',
      version: 1,
      roleKey: 'backend-node-v1',
      opportunityType: 'contributor',
      workMode: 'remote',
      hoursRequiredPerWeek: 8,
      commitmentMonths: 3,
      mandatoryAvailability: true,
      mandatoryCommitment: false,
      industryTags: ['fintech'],
      missionTags: ['reliability', 'automation'],
      ipPolicyVersion: 'creator-owned-v3.0',
      compensation: {
        type: 'paid',
        amountMinor: 200_000,
        paymentDueDays: 7,
        methodNote: 'External bank/UPI transfer agreed directly.',
      },
    });
    expect(docs[0]!.requiredSkills).toEqual([
      { skillId: 'nodejs', level: 4, importance: 2, mandatory: false },
      { skillId: 'rest-api', level: 3, importance: 1, mandatory: true },
    ]);
    expect(briefPublishGaps(DEMO_BRIEFS[0]!.fields)).toEqual([]);
    const summary = await seedDemoAccounts(db.conn, silentLogger, {
      demoMode: true,
      password: PASSWORD,
    });
    expect(summary.briefsCreated).toBe(0);
    expect(await StartupBrief.countDocuments({ seedKey: 'demo:brief:paypilot' })).toBe(1);
  });

  it('shows the seeded brief to a cohort candidate as a teaser only', async () => {
    const c = await as('asha');
    const list = await c.get('/startups?scope=discover');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    const id = list.body.data[0].id as string;
    const view = await c.get(`/startups/${id}`);
    expect(view.body.data.access).toBe('preview');
    expect(view.body.data.preview.founder).toMatchObject({
      displayName: expect.stringContaining('PayPilot'),
      companyUrl: 'https://paypilot.example',
      demoAccount: true,
    });
    expect(JSON.stringify(view.body)).not.toMatch(/partial-payment matching rules|by hand/);
  });
});

describe('brief lifecycle on MongoDB', () => {
  it('creates, edits, publishes, clones and closes with conditional writes and idempotency', async () => {
    const f = await as('founder');
    const headers = key();
    const created = await f.post('/startups', { title: 'Mongo brief' }, headers);
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect((await f.post('/startups', { title: 'Mongo brief' }, headers)).body.data.id).toBe(id);
    const { StartupBrief } = briefModels(db.conn);
    expect(await StartupBrief.countDocuments({ title: 'Mongo brief' })).toBe(1);

    const fields = {
      ...emptyBriefDraft('Mongo brief'),
      teaser: 'A teaser that is comfortably longer than fifty characters in total.',
      problem: 'A problem statement that is comfortably longer than fifty characters.',
      solution: 'A solution statement that is comfortably longer than fifty characters.',
      industryTags: ['commerce'],
      missionTags: ['access'],
      requiredSkills: [{ skillId: 'mongodb', level: 3, importance: 4, mandatory: true }],
      hoursRequiredPerWeek: 6,
      commitmentMonths: 2,
      compensation: {
        type: 'unpaid',
        amountMinor: null,
        paymentDueDays: null,
        methodNote: '',
        benefitDescription: '',
      },
    };
    const { title: _t, ...changes } = fields;
    const patched = await f.patch(`/startups/${id}`, { expectedVersion: 0, changes });
    expect(patched.status).toBe(200);
    expect(patched.body.data.version).toBe(1);
    expect(
      (await f.patch(`/startups/${id}`, { expectedVersion: 0, changes: { title: 'x' } })).status,
    ).toBe(409);

    const pub = await f.post(`/startups/${id}/publish`, { expectedVersion: 1 }, key());
    expect(pub.status).toBe(200);
    expect(pub.body.data).toMatchObject({ status: 'open', version: 1 });

    const clone = await f.post(`/startups/${id}/clone`, {}, key());
    expect(clone.status).toBe(201);
    expect(clone.body.data).toMatchObject({ status: 'draft', version: 0, clonedFromId: id });

    const closed = await f.post(`/startups/${id}/close`, { reason: 'Done' }, key());
    expect(closed.body.data.status).toBe('closed');
    const stored = await StartupBrief.findById(id).lean().exec();
    expect(stored).toMatchObject({ status: 'closed', closeReason: 'Done', transitionRevision: 2 });

    const mine = await f.get('/startups?scope=mine&limit=1');
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].id).toBe(clone.body.data.id);
    const next = await f.get(`/startups?scope=mine&limit=1&cursor=${mine.body.nextCursor}`);
    expect(next.body.data[0].id).toBe(id);
  });
});

describe('resumes on MongoDB with local file storage', () => {
  it('stores the original privately, replaces it and deletes everything on request', async () => {
    const c = await as('asha');
    const up = await c.upload('/candidate/resume', pdf('resume-text'), {
      'Content-Type': 'application/pdf',
      'X-Resume-Consent': RESUME_POLICY_VERSION,
      'X-Expected-Version': '0',
      'X-Filename': 'resume.pdf',
    });
    expect(up.status).toBe(200);
    const stored = fs.readdirSync(storageDir).filter((n) => !n.startsWith('.'));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/^[a-f0-9]{32}\.pdf$/);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(storageDir, stored[0]!)).mode & 0o777).toBe(0o600);
    }
    const Resume = resumeModel(db.conn);
    const asha = await identityModels(db.conn)
      .User.findOne({ emailLower: email('asha') })
      .lean()
      .exec();
    const doc = await Resume.findOne({ userId: asha!._id }).lean().exec();
    expect(doc?.current?.extractedText).toContain('Node.js REST API');

    const replaced = await c.upload('/candidate/resume', pdf('resume-no-text'), {
      'Content-Type': 'application/pdf',
      'X-Resume-Consent': RESUME_POLICY_VERSION,
      'X-Expected-Version': '1',
    });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(replaced.body.data.resume).toMatchObject({ version: 2, filename: 'resume.pdf' });
    const afterReplace = fs.readdirSync(storageDir).filter((n) => !n.startsWith('.'));
    expect(afterReplace).toHaveLength(1);
    expect(afterReplace[0]).not.toBe(stored[0]);

    expect((await c.delete('/candidate/resume')).status).toBe(204);
    expect(fs.readdirSync(storageDir)).toEqual([]);
    const cleared = await Resume.findOne({ userId: asha!._id }).lean().exec();
    expect(cleared).toMatchObject({ version: 3, current: null });
  });

  it('local storage refuses keys that are not server-generated', async () => {
    const storage = createLocalFileStorage(storageDir);
    await expect(storage.get('../../etc/passwd')).rejects.toThrow('invalid storage key');
    await expect(storage.delete('a'.repeat(31))).rejects.toThrow('invalid storage key');
    expect(await storage.get('0'.repeat(32))).toBeNull();
  });

  it('seed --reset removes demo briefs, resumes and their files', async () => {
    const c = await as('dev');
    await c.upload('/candidate/resume', pdf('resume-text'), {
      'Content-Type': 'application/pdf',
      'X-Resume-Consent': RESUME_POLICY_VERSION,
      'X-Expected-Version': '0',
    });
    const storage = createLocalFileStorage(storageDir);
    const summary = await seedDemoAccounts(db.conn, silentLogger, {
      demoMode: true,
      password: PASSWORD,
      reset: true,
      deleteResumeFile: async (k) => {
        deletedFiles.push(k);
        await storage.delete(k);
      },
    });
    expect(deletedFiles).toHaveLength(1);
    expect(fs.readdirSync(storageDir)).toEqual([]);
    expect(await resumeModel(db.conn).countDocuments()).toBe(0);
    const { StartupBrief } = briefModels(db.conn);
    // Demo briefs are recreated from the fixture; ad-hoc demo briefs are gone.
    expect(await StartupBrief.countDocuments()).toBe(1);
    expect(summary.briefsCreated).toBe(1);
  });
});
