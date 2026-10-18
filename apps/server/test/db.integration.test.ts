import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { checkTransactionSupport, pingDatabase } from '../src/db/mongo.js';
import { LATEST_MIGRATION, getMigrationStatus, runMigrations } from '../src/db/migrations.js';
import { computeReadiness } from '../src/db/readiness.js';
import { createInternalApp } from '../src/http/internal.js';
import { silentLogger } from './helpers.js';
import { expectTransactions, openTestDb, type TestDb } from './support/db.js';

let db: TestDb;

beforeAll(async () => {
  db = await openTestDb('core');
});

afterAll(async () => {
  await db?.close();
});

describe('MongoDB connectivity', () => {
  it('pings the database', async () => {
    const result = await pingDatabase(db.conn);
    expect(result.ok).toBe(true);
  });

  it(`reports transaction support = ${expectTransactions}`, async () => {
    const result = await checkTransactionSupport(db.conn);
    expect(result.supported).toBe(expectTransactions);
  });
});

describe('migrations', () => {
  it('starts with every migration pending', async () => {
    const status = await getMigrationStatus(db.conn);
    expect(status).toMatchObject({ current: 0, expected: LATEST_MIGRATION, upToDate: false });
  });

  it('applies pending migrations once and is idempotent', async () => {
    expect(await runMigrations(db.conn, silentLogger)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await runMigrations(db.conn, silentLogger)).toEqual([]);
    const status = await getMigrationStatus(db.conn);
    expect(status).toMatchObject({ current: LATEST_MIGRATION, upToDate: true, pending: [] });
  });

  it('creates the identity indexes required by Section 14', async () => {
    const users = await db.conn.db!.collection('users').indexes();
    const sessions = await db.conn.db!.collection('sessions').indexes();
    const byName = (list: typeof users, name: string) => list.find((i) => i.name === name);
    expect(byName(users, 'emailLower_unique')).toMatchObject({
      unique: true,
      key: { emailLower: 1 },
    });
    expect(byName(sessions, 'tokenHash_unique')).toMatchObject({
      unique: true,
      key: { tokenHash: 1 },
    });
    expect(byName(sessions, 'expiresAt')).toMatchObject({ key: { expiresAt: 1 } });
    expect(byName(sessions, 'lastSeenAt')).toMatchObject({ key: { lastSeenAt: 1 } });
    expect(byName(sessions, 'userId')).toMatchObject({ key: { userId: 1 } });
  });

  it('creates the profile and consent indexes', async () => {
    const list = (name: string) => db.conn.db!.collection(name).indexes();
    const candidate = await list('candidate_profiles');
    const founder = await list('founder_profiles');
    const consent = await list('consent_records');
    expect(candidate.find((i) => i.name === 'userId_unique')).toMatchObject({ unique: true });
    expect(founder.find((i) => i.name === 'userId_unique')).toMatchObject({ unique: true });
    const active = consent.find((i) => i.name === 'active_consent_unique');
    expect(active).toMatchObject({ unique: true, key: { activeKey: 1 } });
    // MongoDB reports sparse: true. Behaviour (many withdrawn records, one active) is asserted in
    // profiles.integration.test.ts on every server.
    if (active && 'sparse' in active) expect(active.sparse).toBe(true);
  });

  it('rejects duplicate migration versions', async () => {
    const noop = async () => undefined;
    await expect(
      runMigrations(db.conn, silentLogger, [
        { version: 9, name: 'a', up: noop },
        { version: 9, name: 'b', up: noop },
      ]),
    ).rejects.toThrow(/duplicate/);
  });
});

describe('readiness', () => {
  it('reports database, transaction and migration checks without secrets', async () => {
    const report = await computeReadiness(db.conn);
    expect(report.checks.database.ok).toBe(true);
    expect(report.checks.migrations).toMatchObject({ ok: true, current: LATEST_MIGRATION });
    expect(report.checks.transactions.ok).toBe(expectTransactions);
    expect(report.status).toBe(expectTransactions ? 'ready' : 'not_ready');
    expect(JSON.stringify(report)).not.toMatch(/mongodb:\/\//);
  });

  it('serves the report on the internal app with 200/503', async () => {
    const res = await request(createInternalApp(() => db.conn)).get('/ready');
    expect(res.status).toBe(expectTransactions ? 200 : 503);
    expect(res.body.data.checks.database.ok).toBe(true);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers 503 when no connection exists', async () => {
    const res = await request(createInternalApp(() => null)).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});
