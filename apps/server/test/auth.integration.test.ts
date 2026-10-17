import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sha256 } from '../src/auth/crypto.js';
import { identityModels } from '../src/auth/models.js';
import { createMongoIdentityStore } from '../src/auth/store.js';
import { DEMO_ACCOUNTS } from '../src/db/demo-accounts.js';
import { runMigrations } from '../src/db/migrations.js';
import { SeedRefusedError, seedDemoAccounts } from '../src/db/seed.js';
import { silentLogger } from './helpers.js';
import { openTestDb, type TestDb } from './support/db.js';
import { TestClient, buildHarness, sessionCookie, type Harness } from './support/harness.js';

/** Identity flows against a real database: Mongo store, migrations, indexes and seeding. */

const PASSWORD = 'demo-password-for-tests';
const FOUNDER = DEMO_ACCOUNTS.find((a) => a.roles.includes('founder'))!.email;
const MODERATOR = DEMO_ACCOUNTS.find((a) => a.roles.includes('moderator'))!.email;

let db: TestDb;
let h: Harness;

beforeAll(async () => {
  db = await openTestDb('auth');
  await runMigrations(db.conn, silentLogger);
  h = buildHarness({ store: createMongoIdentityStore(db.conn) });
});

afterAll(async () => {
  await db?.close();
});

describe('demo seeding (Section 26)', () => {
  it('refuses to run unless DEMO_MODE is on', async () => {
    await expect(
      seedDemoAccounts(db.conn, silentLogger, { demoMode: false, password: PASSWORD }),
    ).rejects.toBeInstanceOf(SeedRefusedError);
  });

  it('refuses passwords outside 12-128 characters', async () => {
    await expect(
      seedDemoAccounts(db.conn, silentLogger, { demoMode: true, password: 'short' }),
    ).rejects.toThrow(/12-128/);
  });

  it('creates every demo account with an Argon2id hash and demo labels', async () => {
    const summary = await seedDemoAccounts(db.conn, silentLogger, {
      demoMode: true,
      password: PASSWORD,
    });
    expect(summary.created).toHaveLength(DEMO_ACCOUNTS.length);
    const { User } = identityModels(db.conn);
    const founder = await User.findOne({ emailLower: FOUNDER }).lean().exec();
    expect(founder).toMatchObject({
      roles: ['founder'],
      status: 'active',
      accountMode: 'demo',
      authVersion: 1,
      emailVerifiedAt: null,
    });
    expect(founder?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const summary = await seedDemoAccounts(db.conn, silentLogger, {
      demoMode: true,
      password: PASSWORD,
    });
    expect(summary.created).toEqual([]);
    expect(summary.updated).toEqual([]);
    expect(summary.unchanged).toHaveLength(DEMO_ACCOUNTS.length);
    const { User } = identityModels(db.conn);
    expect(await User.countDocuments({ accountMode: 'demo' })).toBe(DEMO_ACCOUNTS.length);
  });

  it('enforces unique emails at the database level', async () => {
    const { User } = identityModels(db.conn);
    await expect(
      User.create({
        emailLower: FOUNDER,
        passwordHash: 'x',
        displayName: 'Duplicate',
        roles: ['founder'],
        cohortId: 'demo-v3.0',
        status: 'active',
        accountMode: 'demo',
        authVersion: 1,
      }),
    ).rejects.toThrow(/duplicate key|E11000/i);
  });
});

describe('login against MongoDB', () => {
  it('signs in a seeded account, stores only token hashes and rotates the session', async () => {
    const client = new TestClient(h.app);
    const boot = await client.agent.get('/api/v1/auth/csrf');
    client.csrf = boot.body.data.csrfToken;
    const anonToken = sessionCookie(boot) ?? '';

    const res = await client.post('/auth/login', { email: FOUNDER, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ email: FOUNDER, roles: ['founder'] });
    const token = sessionCookie(res) ?? '';

    const { Session } = identityModels(db.conn);
    expect(await Session.countDocuments({ tokenHash: sha256(anonToken) })).toBe(0);
    const stored = await Session.findOne({ tokenHash: sha256(token) })
      .lean()
      .exec();
    expect(stored?.userId).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(token);

    await client.refreshCsrf();
    expect((await client.get('/me')).body.data.user.email).toBe(FOUNDER);
    expect((await client.post('/auth/logout')).status).toBe(204);
    expect(await Session.countDocuments({ tokenHash: sha256(token) })).toBe(0);
  });

  it('rejects wrong passwords with the generic error', async () => {
    const client = new TestClient(h.app);
    const res = await client.post('/auth/login', {
      email: MODERATOR,
      password: 'not-the-password',
    });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Email or password is incorrect.');
  });

  it('a changed demo password re-hashes, bumps authVersion and ends old sessions', async () => {
    const client = new TestClient(h.app);
    await client.login(MODERATOR, PASSWORD);
    expect((await client.get('/me')).status).toBe(200);

    const summary = await seedDemoAccounts(db.conn, silentLogger, {
      demoMode: true,
      password: 'a-new-demo-password',
    });
    expect(summary.updated).toHaveLength(DEMO_ACCOUNTS.length);
    expect((await client.get('/me')).status).toBe(401);

    const fresh = new TestClient(h.app);
    expect((await fresh.login(MODERATOR, PASSWORD)).status).toBe(401);
    expect((await fresh.login(MODERATOR, 'a-new-demo-password')).status).toBe(200);
  });

  it('revokes every session of a user', async () => {
    const a = new TestClient(h.app);
    const b = new TestClient(h.app);
    await a.login(FOUNDER, 'a-new-demo-password');
    await b.login(FOUNDER, 'a-new-demo-password');
    const { User } = identityModels(db.conn);
    const user = await User.findOne({ emailLower: FOUNDER }).lean().exec();
    expect(await h.auth.revokeAllSessions(user!._id.toHexString())).toBe(2);
    expect((await a.get('/me')).status).toBe(401);
  });

  it('--reset removes demo accounts and their sessions, then recreates them', async () => {
    const client = new TestClient(h.app);
    await client.login(FOUNDER, 'a-new-demo-password');
    const summary = await seedDemoAccounts(db.conn, silentLogger, {
      demoMode: true,
      password: PASSWORD,
      reset: true,
    });
    expect(summary.removed).toBe(DEMO_ACCOUNTS.length);
    expect(summary.created).toHaveLength(DEMO_ACCOUNTS.length);
    expect((await client.get('/me')).status).toBe(401);
  });

  it('refuses to seed a database that holds pilot accounts', async () => {
    const { User } = identityModels(db.conn);
    await User.create({
      emailLower: 'real.person@pilot.example',
      passwordHash: 'x',
      displayName: 'Pilot user',
      roles: ['candidate'],
      cohortId: 'pilot-1',
      status: 'active',
      accountMode: 'pilot',
      authVersion: 1,
    });
    await expect(
      seedDemoAccounts(db.conn, silentLogger, { demoMode: true, password: PASSWORD, reset: true }),
    ).rejects.toThrow(/pilot accounts/);
    // The refused reset deleted nothing.
    expect(await User.countDocuments({ accountMode: 'demo' })).toBe(DEMO_ACCOUNTS.length);
  });

  it('the sweeper deletes expired and idle sessions in MongoDB', async () => {
    const { Session } = identityModels(db.conn);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await Session.create([
      {
        tokenHash: 'a'.repeat(64),
        userId: null,
        csrfTokenHash: 'x',
        authVersion: 0,
        lastSeenAt: old,
        expiresAt: old,
      },
      {
        tokenHash: 'b'.repeat(64),
        userId: db.conn.base.Types.ObjectId.createFromTime(1),
        csrfTokenHash: 'x',
        authVersion: 1,
        lastSeenAt: old,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    expect(await h.auth.purgeExpiredSessions()).toBeGreaterThanOrEqual(2);
    expect(
      await Session.countDocuments({ tokenHash: { $in: ['a'.repeat(64), 'b'.repeat(64)] } }),
    ).toBe(0);
  });

  it('serves 401 to requests whose cookie session vanished from the database', async () => {
    const client = new TestClient(h.app);
    await client.login(FOUNDER, PASSWORD);
    const { Session } = identityModels(db.conn);
    await Session.deleteMany({});
    const res = await request(h.app).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect((await client.get('/me')).status).toBe(401);
  });
});
