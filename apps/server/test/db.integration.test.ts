import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Connection } from 'mongoose';
import { connectMongo, checkTransactionSupport, pingDatabase } from '../src/db/mongo.js';
import { LATEST_MIGRATION, getMigrationStatus, runMigrations } from '../src/db/migrations.js';
import { computeReadiness } from '../src/db/readiness.js';
import { createInternalApp } from '../src/http/internal.js';
import { silentLogger } from './helpers.js';

/**
 * Real database integration test.
 *  - Default: starts an in-memory MongoDB replica set (mongodb-memory-server downloads a mongod
 *    binary on first run), so transactions are available and readiness must be "ready".
 *  - MONGODB_TEST_URI: use an existing server instead. Set MONGODB_TEST_EXPECT_TRANSACTIONS=false
 *    when that server is not a replica set; the readiness probe must then report not_ready.
 */

const externalUri = process.env.MONGODB_TEST_URI;
const expectTransactions = process.env.MONGODB_TEST_EXPECT_TRANSACTIONS !== 'false';

let stop: (() => Promise<void>) | null = null;
let conn: Connection;

beforeAll(async () => {
  let uri = externalUri;
  if (!uri) {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    uri = replSet.getUri('cofoundry-test');
    stop = async () => {
      await replSet.stop();
    };
  }
  conn = await connectMongo(uri, silentLogger, { serverSelectionTimeoutMS: 15_000 });
  await conn.db?.dropDatabase();
});

afterAll(async () => {
  await conn?.db?.dropDatabase().catch(() => undefined);
  await conn?.close();
  await stop?.();
});

describe('MongoDB connectivity', () => {
  it('pings the database', async () => {
    const result = await pingDatabase(conn);
    expect(result.ok).toBe(true);
  });

  it(`reports transaction support = ${expectTransactions}`, async () => {
    const result = await checkTransactionSupport(conn);
    expect(result.supported).toBe(expectTransactions);
  });
});

describe('migrations', () => {
  it('starts with every migration pending', async () => {
    const status = await getMigrationStatus(conn);
    expect(status).toMatchObject({ current: 0, expected: LATEST_MIGRATION, upToDate: false });
  });

  it('applies pending migrations once and is idempotent', async () => {
    expect(await runMigrations(conn, silentLogger)).toEqual([1]);
    expect(await runMigrations(conn, silentLogger)).toEqual([]);
    const status = await getMigrationStatus(conn);
    expect(status).toMatchObject({ current: LATEST_MIGRATION, upToDate: true, pending: [] });
  });

  it('rejects duplicate migration versions', async () => {
    const noop = async () => undefined;
    await expect(
      runMigrations(conn, silentLogger, [
        { version: 9, name: 'a', up: noop },
        { version: 9, name: 'b', up: noop },
      ]),
    ).rejects.toThrow(/duplicate/);
  });
});

describe('readiness', () => {
  it('reports database, transaction and migration checks without secrets', async () => {
    const report = await computeReadiness(conn);
    expect(report.checks.database.ok).toBe(true);
    expect(report.checks.migrations).toMatchObject({ ok: true, current: LATEST_MIGRATION });
    expect(report.checks.transactions.ok).toBe(expectTransactions);
    expect(report.status).toBe(expectTransactions ? 'ready' : 'not_ready');
    expect(JSON.stringify(report)).not.toMatch(/mongodb:\/\//);
  });

  it('serves the report on the internal app with 200/503', async () => {
    const res = await request(createInternalApp(() => conn)).get('/ready');
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
