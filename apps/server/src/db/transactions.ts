import type { Connection, mongo } from 'mongoose';
import type { Logger } from '../lib/logger.js';

/**
 * Multi-document atomicity for paired workflow changes (Contract Section 25).
 *
 * Every operation that changes two users' relationship (request accept, match end, sprint
 * transitions that also end the match, blocks, suspensions) runs inside `run`. In production
 * MongoDB is a replica set and `run` is a real transaction: write conflicts abort and retry
 * (capped at 3 attempts) and any thrown error rolls every write back. Startup refuses to run in
 * production without transaction support (see index.ts).
 *
 * Development and the local E2E suite may use a MongoDB-compatible server without transactions
 * (FerretDB). There `atomic` is false and the same code runs without a session: the unique
 * indexes still make duplicates impossible and the RelationshipGuard compare-and-set still
 * serialises pair mutations, but a crash between two writes is not rolled back. This mode is
 * logged at startup and is never used in production.
 */

export interface Tx {
  /** The MongoDB session to pass to every read and write; null when not transactional. */
  readonly session: mongo.ClientSession | null;
}

export interface TransactionRunner {
  readonly atomic: boolean;
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export const NO_TX: Tx = Object.freeze({ session: null });

export const TRANSACTION_MAX_ATTEMPTS = 3;

function hasLabel(err: unknown, label: string): boolean {
  const e = err as { hasErrorLabel?: (l: string) => boolean; errorLabels?: string[] } | null;
  if (!e || typeof e !== 'object') return false;
  if (typeof e.hasErrorLabel === 'function') return e.hasErrorLabel(label);
  return Array.isArray(e.errorLabels) && e.errorLabels.includes(label);
}

export function createMongoTransactionRunner(
  conn: Connection,
  options: { atomic: boolean; logger?: Logger },
): TransactionRunner {
  if (!options.atomic) {
    return {
      atomic: false,
      run: (fn) => fn(NO_TX),
    };
  }
  return {
    atomic: true,
    async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      let lastError: unknown;
      for (let attempt = 1; attempt <= TRANSACTION_MAX_ATTEMPTS; attempt += 1) {
        const session = await conn.startSession();
        try {
          session.startTransaction({
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
          });
          const result = await fn({ session: session as unknown as mongo.ClientSession });
          // Commit; an unknown commit result is safe to retry (the commit is idempotent).
          for (let c = 1; ; c += 1) {
            try {
              await session.commitTransaction();
              break;
            } catch (err) {
              if (c < TRANSACTION_MAX_ATTEMPTS && hasLabel(err, 'UnknownTransactionCommitResult'))
                continue;
              throw err;
            }
          }
          return result;
        } catch (err) {
          lastError = err;
          if (session.inTransaction()) await session.abortTransaction().catch(() => undefined);
          if (attempt < TRANSACTION_MAX_ATTEMPTS && hasLabel(err, 'TransientTransactionError')) {
            options.logger?.warn({ attempt }, 'transaction write conflict; retrying');
            continue;
          }
          throw err;
        } finally {
          await session.endSession();
        }
      }
      throw lastError;
    },
  };
}

/** Options object for native driver calls: `{ session }` only when transactional. */
export function sessionOpt(tx: Tx | undefined): { session?: mongo.ClientSession } {
  return tx?.session ? { session: tx.session } : {};
}
