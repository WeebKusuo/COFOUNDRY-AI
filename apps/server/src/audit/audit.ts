import mongoose, { type Connection } from 'mongoose';
import { RecordCollection } from '../db/record-collection.js';
import type { Tx } from '../db/transactions.js';
import type { AuditEventRecord } from '../safety/records.js';

/**
 * Append-only audit trail (Contract Sections 16, 25). Events reference users by id only and
 * never carry message, note, answer, URL or contact content. There is no update or delete path;
 * retention (24 months) is applied by a later phase's retention job, not a TTL.
 */

export interface AuditStore {
  append(e: AuditEventRecord, tx?: Tx): Promise<void>;
  listForTarget(targetType: string, targetId: string): Promise<AuditEventRecord[]>;
}

export interface AuditContext {
  requestId?: string | null;
}

export type AuditMetadata = AuditEventRecord['metadata'];

export class AuditLog {
  constructor(
    private readonly store: AuditStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(
    event: {
      actorId: string | null;
      action: string;
      targetType: string;
      targetId: string;
      metadata?: AuditMetadata;
    },
    ctx: AuditContext = {},
    tx?: Tx,
  ): Promise<void> {
    await this.store.append(
      {
        id: new mongoose.Types.ObjectId().toHexString(),
        actorId: event.actorId,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        requestId: ctx.requestId ?? null,
        time: this.now(),
        metadata: event.metadata ?? {},
      },
      tx,
    );
  }

  list(targetType: string, targetId: string): Promise<AuditEventRecord[]> {
    return this.store.listForTarget(targetType, targetId);
  }
}

export const AUDIT_COLLECTION = 'audit_events';

export function createMongoAuditStore(conn: Connection): AuditStore {
  const c = new RecordCollection<AuditEventRecord>(conn, AUDIT_COLLECTION, ['actorId']);
  return {
    async append(e, tx) {
      await c.insert(e, tx);
    },
    listForTarget: (targetType, targetId) =>
      c.find({ targetType, targetId }, { sort: { time: 1, _id: 1 } }),
  };
}
