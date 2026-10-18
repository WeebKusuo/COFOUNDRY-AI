import type { Connection } from 'mongoose';
import type { CaseKind, CaseStatus, ReportTargetType } from '@cofoundry/shared';
import type { PageRequest } from '../briefs/store.js';
import { RecordCollection, oid, pageFilter } from '../db/record-collection.js';
import { sessionOpt, type Tx } from '../db/transactions.js';
import type { BlockRecord, SafetyCaseRecord } from './records.js';

/** Persistence ports for blocks, the relationship guard and safety cases (Section 16). */

export interface BlockStore {
  /** Idempotent on the directed pair: returns the stored block. */
  insert(b: BlockRecord, tx?: Tx): Promise<BlockRecord>;
  remove(blockerUserId: string, blockedUserId: string): Promise<boolean>;
  listByBlocker(blockerUserId: string): Promise<BlockRecord[]>;
  /** A block in either direction between a and b. */
  existsEither(a: string, b: string, tx?: Tx): Promise<boolean>;
  /** Of `others`, those with a block in either direction with `userId`. */
  blockedAmong(userId: string, others: readonly string[]): Promise<Set<string>>;
}

/**
 * Section 25 RelationshipGuard: one row per unordered user pair, written by every block or
 * relationship mutation inside its transaction. Two transactions touching the same pair
 * therefore write-conflict and one retries, re-reading block and account state.
 */
export interface RelationshipGuardStore {
  touch(a: string, b: string, tx?: Tx): Promise<number>;
}

export interface CaseListFilter {
  reporterUserId?: string;
  status?: CaseStatus;
}

export interface SafetyCaseStore {
  insert(c: SafetyCaseRecord): Promise<'created' | 'exists'>;
  findById(id: string, tx?: Tx): Promise<SafetyCaseRecord | null>;
  replace(next: SafetyCaseRecord, expectedRev: number, tx?: Tx): Promise<SafetyCaseRecord | null>;
  list(filter: CaseListFilter, page: PageRequest): Promise<SafetyCaseRecord[]>;
  countByReporterSince(reporterUserId: string, since: Date): Promise<number>;
  findOpenDuplicate(
    reporterUserId: string,
    kind: CaseKind,
    targetType: ReportTargetType,
    targetId: string,
  ): Promise<SafetyCaseRecord | null>;
  findForTarget(targetType: ReportTargetType, targetId: string): Promise<SafetyCaseRecord[]>;
  /** Cases holding evidence under a dispute hold that has not been released. */
  findActiveHolds(): Promise<SafetyCaseRecord[]>;
}

export const SAFETY_COLLECTIONS = {
  blocks: 'blocks',
  guards: 'relationship_guards',
  cases: 'safety_cases',
} as const;

export function guardKey(a: string, b: string): { low: string; high: string; key: string } {
  const [low, high] = a < b ? [a, b] : [b, a];
  return { low, high, key: `${low}:${high}` };
}

export function createMongoBlockStore(conn: Connection): BlockStore {
  const c = new RecordCollection<BlockRecord>(conn, SAFETY_COLLECTIONS.blocks, [
    'blockerUserId',
    'blockedUserId',
  ]);
  const either = (a: string, b: string) => ({
    $or: [
      { blockerUserId: oid(a), blockedUserId: oid(b) },
      { blockerUserId: oid(b), blockedUserId: oid(a) },
    ],
  });
  return {
    async insert(b, tx) {
      const res = await c
        .col()
        .findOneAndUpdate(
          { blockerUserId: oid(b.blockerUserId), blockedUserId: oid(b.blockedUserId) },
          { $setOnInsert: c.toDoc(b) },
          { upsert: true, returnDocument: 'after', ...sessionOpt(tx) },
        );
      return c.fromDoc(res!);
    },
    async remove(blocker, blocked) {
      const r = await c
        .col()
        .deleteOne({ blockerUserId: oid(blocker), blockedUserId: oid(blocked) });
      return r.deletedCount > 0;
    },
    listByBlocker: (blocker) =>
      c.find({ blockerUserId: blocker }, { sort: { createdAt: -1, _id: -1 } }),
    existsEither: async (a, b, tx) =>
      (await c.col().findOne(either(a, b), sessionOpt(tx))) !== null,
    async blockedAmong(userId, others) {
      if (others.length === 0) return new Set();
      const ids = others.map(oid);
      const docs = await c
        .col()
        .find({
          $or: [
            { blockerUserId: oid(userId), blockedUserId: { $in: ids } },
            { blockedUserId: oid(userId), blockerUserId: { $in: ids } },
          ],
        })
        .toArray();
      const out = new Set<string>();
      for (const d of docs) {
        const b = c.fromDoc(d);
        out.add(b.blockerUserId === userId ? b.blockedUserId : b.blockerUserId);
      }
      return out;
    },
  };
}

export function createMongoRelationshipGuardStore(conn: Connection): RelationshipGuardStore {
  const col = () =>
    conn.db!.collection<{ _id: string; lowUserId: string; highUserId: string; revision: number }>(
      SAFETY_COLLECTIONS.guards,
    );
  return {
    async touch(a, b, tx) {
      const { low, high, key } = guardKey(a, b);
      if (tx?.session) {
        // Create the row outside the transaction first: concurrent transactional upserts of a
        // missing row would fail on the unique _id instead of raising a retryable write conflict.
        await col().updateOne(
          { _id: key },
          { $setOnInsert: { lowUserId: low, highUserId: high, revision: 0 } },
          { upsert: true },
        );
      }
      const res = await col().findOneAndUpdate(
        { _id: key },
        { $inc: { revision: 1 }, $setOnInsert: { lowUserId: low, highUserId: high } },
        { upsert: true, returnDocument: 'after', ...sessionOpt(tx) },
      );
      return res?.revision ?? 1;
    },
  };
}

export function createMongoSafetyCaseStore(conn: Connection): SafetyCaseStore {
  const c = new RecordCollection<SafetyCaseRecord>(conn, SAFETY_COLLECTIONS.cases, [
    'reporterUserId',
    'targetUserId',
    'assignedModeratorId',
  ]);
  return {
    async insert(r) {
      const res = await c.insert(r);
      return res === 'created' ? 'created' : 'exists';
    },
    findById: (id, tx) => c.findById(id, tx),
    replace: (next, rev, tx) => c.replace(next, rev, tx),
    list: (filter, page) =>
      c.find(
        {
          ...(filter.reporterUserId ? { reporterUserId: filter.reporterUserId } : {}),
          ...(filter.status ? { status: filter.status } : {}),
          ...pageFilter(page.after),
        },
        { sort: { createdAt: -1, _id: -1 }, limit: page.limit + 1 },
      ),
    countByReporterSince: (reporterUserId, since) =>
      c.count({ reporterUserId, createdAt: { $gte: since } }),
    findOpenDuplicate: (reporterUserId, kind, targetType, targetId) =>
      c.findOne({
        reporterUserId,
        kind,
        targetType,
        targetId,
        status: { $in: ['open', 'in_review'] },
      }),
    findForTarget: (targetType, targetId) =>
      c.find({ targetType, targetId }, { sort: { createdAt: 1, _id: 1 } }),
    findActiveHolds: () => c.find({ hold: { $ne: null }, 'hold.releasedAt': null }),
  };
}
