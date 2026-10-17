import type { Connection } from 'mongoose';
import { checkTransactionSupport, pingDatabase } from './mongo.js';
import { getMigrationStatus } from './migrations.js';

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checks: {
    database: { ok: boolean; latencyMs: number };
    transactions: { ok: boolean };
    migrations: { ok: boolean; current: number; expected: number };
  };
}

/**
 * Internal readiness (Section 22): DB connectivity, transaction support and migration version.
 * Never includes connection strings, hostnames or error internals.
 */
export async function computeReadiness(conn: Connection): Promise<ReadinessReport> {
  const database = await pingDatabase(conn);
  if (!database.ok) {
    return {
      status: 'not_ready',
      checks: {
        database,
        transactions: { ok: false },
        migrations: { ok: false, current: 0, expected: 0 },
      },
    };
  }
  const [tx, migrations] = await Promise.all([
    checkTransactionSupport(conn),
    getMigrationStatus(conn),
  ]);
  const ok = database.ok && tx.supported && migrations.upToDate;
  return {
    status: ok ? 'ready' : 'not_ready',
    checks: {
      database,
      transactions: { ok: tx.supported },
      migrations: {
        ok: migrations.upToDate,
        current: migrations.current,
        expected: migrations.expected,
      },
    },
  };
}
