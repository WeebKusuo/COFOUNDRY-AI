import mongoose, { type Connection } from 'mongoose';
import type { Logger } from '../lib/logger.js';

/**
 * MongoDB connectivity (Section 22/25). A dedicated Connection (not the mongoose global) keeps
 * the app testable and lets the worker and API share one pool explicitly.
 */

export interface ConnectOptions {
  serverSelectionTimeoutMS?: number;
  appName?: string;
}

export async function connectMongo(
  uri: string,
  logger: Logger,
  options: ConnectOptions = {},
): Promise<Connection> {
  const conn = mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMS ?? 10_000,
    appName: options.appName ?? 'cofoundry-server',
    // Indexes are created by versioned migrations, never implicitly at model compile time.
    autoIndex: false,
    autoCreate: false,
  });
  conn.on('disconnected', () => {
    if (!closing.has(conn)) logger.warn('mongodb disconnected');
  });
  conn.on('reconnected', () => logger.info('mongodb reconnected'));
  await conn.asPromise();
  return conn;
}

const closing = new WeakSet<Connection>();

/** Intentional shutdown: closes the pool without logging it as an outage. */
export async function closeMongo(conn: Connection): Promise<void> {
  closing.add(conn);
  await conn.close();
}

export async function pingDatabase(conn: Connection): Promise<{ ok: boolean; latencyMs: number }> {
  const started = performance.now();
  try {
    const db = conn.db;
    if (!db) return { ok: false, latencyMs: 0 };
    await db.admin().command({ ping: 1 });
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - started) };
  }
}

export const CAPABILITY_COLLECTION = '_capability_checks';

/**
 * Proves multi-document transactions actually run (Section 22: startup must fail in production
 * if they cannot). It performs a real transaction rather than trusting topology metadata.
 */
export async function checkTransactionSupport(
  conn: Connection,
): Promise<{ supported: boolean; reason?: string }> {
  const db = conn.db;
  if (!db) return { supported: false, reason: 'not connected' };
  const session = await conn.startSession();
  try {
    const marker = { _id: new mongoose.Types.ObjectId(), at: new Date() };
    await session.withTransaction(async () => {
      const col = db.collection(CAPABILITY_COLLECTION);
      await col.insertOne(marker, { session });
      await col.deleteOne({ _id: marker._id }, { session });
    });
    return { supported: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { supported: false, reason: message.slice(0, 200) };
  } finally {
    await session.endSession();
  }
}
