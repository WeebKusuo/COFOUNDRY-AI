import { randomBytes } from 'node:crypto';
import type { Connection } from 'mongoose';
import { closeMongo, connectMongo } from '../../src/db/mongo.js';
import { silentLogger } from '../helpers.js';

/**
 * Real database for integration tests.
 *  - Default: an in-memory MongoDB replica set (mongodb-memory-server downloads a mongod binary
 *    on first run), so transactions are available.
 *  - MONGODB_TEST_URI: an existing server; set MONGODB_TEST_EXPECT_TRANSACTIONS=false when it is
 *    not a replica set.
 * Each test file gets its own database name, dropped afterwards.
 */
export const expectTransactions = process.env.MONGODB_TEST_EXPECT_TRANSACTIONS !== 'false';

export interface TestDb {
  conn: Connection;
  close: () => Promise<void>;
}

function withDbName(uri: string, name: string): string {
  const url = new URL(uri);
  url.pathname = `/${name}`;
  return url.toString();
}

export async function openTestDb(label: string): Promise<TestDb> {
  const name = `cf-${label}-${randomBytes(4).toString('hex')}`;
  const external = process.env.MONGODB_TEST_URI;
  let stopServer: (() => Promise<void>) | null = null;
  let uri: string;
  if (external) {
    uri = withDbName(external, name);
  } else {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    uri = replSet.getUri(name);
    stopServer = async () => {
      await replSet.stop();
    };
  }
  const conn = await connectMongo(uri, silentLogger, { serverSelectionTimeoutMS: 15_000 });
  return {
    conn,
    close: async () => {
      await conn.db?.dropDatabase().catch(() => undefined);
      await closeMongo(conn);
      await stopServer?.();
    },
  };
}
