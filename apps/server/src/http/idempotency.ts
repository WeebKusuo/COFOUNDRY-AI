import type { Request } from 'express';
import type { UserRecord } from '../auth/store.js';
import type { IdempotencyStore } from '../briefs/store.js';
import { canonicalJson, sha256Hex } from '../lib/canonical-json.js';
import { AppError } from './errors.js';
import { idempotencyKey } from './validation.js';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
const RETENTION_MS = 24 * 60 * 60 * 1000;

export interface IdempotentOutcome<T> {
  status: number;
  data: T;
}

export interface IdempotentOperation<T> {
  store: IdempotencyStore;
  req: Request;
  actor: UserRecord;
  /** Concrete route, e.g. "POST /startups/<id>/publish". */
  route: string;
  /** The validated request body (hashed canonically). */
  body: unknown;
  /** Resource id for this attempt: a fresh id for creates, the target id for transitions. */
  resourceId: string;
  /**
   * Performs the mutation for `resourceId`. Must be safe to repeat with the same id: creates
   * return the existing record, transitions return the already-reached state.
   */
  execute: (resourceId: string) => Promise<IdempotentOutcome<T>>;
  /** Returns the current resource for a completed key, re-checking access first. */
  replay: (resourceId: string) => Promise<T>;
  now?: () => Date;
}

/**
 * Section 17/25 idempotency for POST creates and transitions, without relying on transactions.
 *
 * The (actor, route, key) record is reserved BEFORE the mutation and stores the resource id the
 * mutation will use. A retry after a crash therefore finds the reservation and repeats the
 * mutation for the same id — which the operations make safe — instead of creating a duplicate.
 * A completed key replays the current resource with the original status after re-checking
 * access. The same key with a different body is 409 IDEMPOTENCY_CONFLICT. A failed attempt
 * releases its reservation, so the client may retry with the same key.
 */
export async function runIdempotent<T>(op: IdempotentOperation<T>): Promise<IdempotentOutcome<T>> {
  const parsed = idempotencyKey.safeParse(op.req.get(IDEMPOTENCY_HEADER));
  if (!parsed.success) {
    throw new AppError('BAD_REQUEST', 'Send an Idempotency-Key header (a UUID) with this request.');
  }
  const key = parsed.data.toLowerCase();
  const now = op.now ?? (() => new Date());
  const bodyHash = sha256Hex(canonicalJson(op.body ?? {}));
  const record = {
    actorUserId: op.actor.id,
    route: op.route,
    key,
    bodyHash,
    resourceId: op.resourceId,
    responseStatus: null,
    expiresAt: new Date(now().getTime() + RETENTION_MS),
  };

  let reservation = await op.store.reserve(record);
  if (!reservation.reserved && reservation.existing.expiresAt <= now()) {
    // An expired record no longer protects anything; start over (the sweeper may not have run).
    await op.store.release(op.actor.id, op.route, key);
    reservation = await op.store.reserve(record);
  }

  let resourceId = op.resourceId;
  if (!reservation.reserved) {
    const existing = reservation.existing;
    if (existing.bodyHash !== bodyHash) {
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        'This Idempotency-Key was already used with a different request.',
      );
    }
    if (existing.responseStatus !== null) {
      return { status: existing.responseStatus, data: await op.replay(existing.resourceId) };
    }
    // The first attempt is in flight or crashed before completing: repeat it for the same id.
    resourceId = existing.resourceId;
  }

  let outcome: IdempotentOutcome<T>;
  try {
    outcome = await op.execute(resourceId);
  } catch (err) {
    if (reservation.reserved) await op.store.release(op.actor.id, op.route, key);
    throw err;
  }
  await op.store.complete(op.actor.id, op.route, key, outcome.status);
  return outcome;
}
