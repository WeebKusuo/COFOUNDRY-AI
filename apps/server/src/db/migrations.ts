import type { Connection } from 'mongoose';
import type { Logger } from '../lib/logger.js';
import { CAPABILITY_COLLECTION } from './mongo.js';

/**
 * Versioned, append-only database migrations (Section 29 deliverable: "database
 * index/migration script"). Every `up` must be idempotent so a crashed run can simply be
 * repeated. Later phases append migrations that create the collections and unique indexes of
 * Sections 14-16. Never edit or reorder an applied migration; add a new one.
 */

export interface Migration {
  version: number;
  name: string;
  up: (conn: Connection) => Promise<void>;
}

export const MIGRATIONS_COLLECTION = 'schema_migrations';

async function ensureCollection(conn: Connection, name: string): Promise<void> {
  const db = conn.db;
  if (!db) throw new Error('database not connected');
  const existing = await db.listCollections({ name }, { nameOnly: true }).toArray();
  if (existing.length === 0) await db.createCollection(name);
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'baseline',
    up: async (conn) => {
      // Collections must exist before they are written inside a transaction.
      await ensureCollection(conn, MIGRATIONS_COLLECTION);
      await ensureCollection(conn, CAPABILITY_COLLECTION);
    },
  },
];

export const LATEST_MIGRATION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

interface MigrationRecord {
  _id: number;
  name: string;
  appliedAt: Date;
}

export interface MigrationStatus {
  current: number;
  expected: number;
  pending: number[];
  upToDate: boolean;
}

export async function getMigrationStatus(conn: Connection): Promise<MigrationStatus> {
  const db = conn.db;
  if (!db) throw new Error('database not connected');
  const applied = await db
    .collection<MigrationRecord>(MIGRATIONS_COLLECTION)
    .find({}, { projection: { _id: 1 } })
    .toArray();
  const appliedSet = new Set(applied.map((r) => r._id));
  const pending = MIGRATIONS.filter((m) => !appliedSet.has(m.version)).map((m) => m.version);
  const current = applied.reduce((max, r) => Math.max(max, r._id), 0);
  return { current, expected: LATEST_MIGRATION, pending, upToDate: pending.length === 0 };
}

export async function runMigrations(
  conn: Connection,
  logger: Logger,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<number[]> {
  const db = conn.db;
  if (!db) throw new Error('database not connected');
  const versions = migrations.map((m) => m.version);
  if (new Set(versions).size !== versions.length) throw new Error('duplicate migration version');

  const records = db.collection<MigrationRecord>(MIGRATIONS_COLLECTION);
  const appliedNow: number[] = [];
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    const done = await records.findOne({ _id: migration.version });
    if (done) continue;
    logger.info({ version: migration.version, name: migration.name }, 'applying migration');
    await migration.up(conn);
    await records.updateOne(
      { _id: migration.version },
      { $setOnInsert: { name: migration.name, appliedAt: new Date() } },
      { upsert: true },
    );
    appliedNow.push(migration.version);
  }
  return appliedNow;
}
