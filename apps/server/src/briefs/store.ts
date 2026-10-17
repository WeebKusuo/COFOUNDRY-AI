import mongoose, { type Connection } from 'mongoose';
import type { BriefDraftFields, BriefStatus } from '@cofoundry/shared';
import { OPPORTUNITY_TYPE, ROLE_KEY, VERSIONS, WORK_MODE } from '@cofoundry/shared';
import { briefModels, type IdempotencyRecordDoc, type StartupBriefDoc } from './models.js';

export interface BriefRecord extends BriefDraftFields {
  id: string;
  founderUserId: string;
  status: BriefStatus;
  version: number;
  transitionRevision: number;
  publishedAt: Date | null;
  closedAt: Date | null;
  closeReason: string | null;
  clonedFromId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Opaque-cursor position: newest first, ordered by createdAt then _id (Section 17). */
export interface PagePosition {
  createdAt: Date;
  id: string;
}

export interface PageRequest {
  after: PagePosition | null;
  limit: number;
}

export interface NewDraft {
  /** Pre-generated id so an idempotent retry recreates the same resource. */
  id: string;
  founderUserId: string;
  fields: BriefDraftFields;
  clonedFromId: string | null;
}

/**
 * Persistence port for briefs. Every mutation is one conditional single-document write, so
 * ownership, status and version are checked atomically with the change; null means the
 * condition did not hold (the service re-reads to choose 404 / 409).
 */
export interface BriefStore {
  /** Inserts a draft; when the id already exists the stored record is returned unchanged. */
  insertDraft(draft: NewDraft): Promise<{ record: BriefRecord; created: boolean }>;
  findById(id: string): Promise<BriefRecord | null>;
  /** Returns up to limit + 1 records so the caller can tell whether another page exists. */
  listByFounder(founderUserId: string, page: PageRequest): Promise<BriefRecord[]>;
  listOpenByFounders(founderUserIds: string[], page: PageRequest): Promise<BriefRecord[]>;
  updateDraft(
    id: string,
    founderUserId: string,
    expectedVersion: number,
    changes: Partial<BriefDraftFields>,
  ): Promise<BriefRecord | null>;
  publish(
    id: string,
    founderUserId: string,
    expectedVersion: number,
    normalized: Pick<BriefDraftFields, 'compensation'>,
    at: Date,
  ): Promise<BriefRecord | null>;
  close(id: string, founderUserId: string, reason: string, at: Date): Promise<BriefRecord | null>;
}

export interface IdempotencyRecord {
  actorUserId: string;
  route: string;
  key: string;
  bodyHash: string;
  resourceId: string;
  responseStatus: number | null;
  expiresAt: Date;
}

export interface IdempotencyStore {
  /** Inserts the record unless (actor, route, key) exists; then returns the existing record. */
  reserve(
    record: IdempotencyRecord,
  ): Promise<{ reserved: true } | { reserved: false; existing: IdempotencyRecord }>;
  complete(actorUserId: string, route: string, key: string, responseStatus: number): Promise<void>;
  /** Removes a reservation (the attempt failed, or the record expired) so the key can be reused. */
  release(actorUserId: string, route: string, key: string): Promise<void>;
  purgeExpired(now: Date): Promise<number>;
}

const oid = (id: string) => new mongoose.Types.ObjectId(id);

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

export function toBriefRecord(doc: StartupBriefDoc): BriefRecord {
  return {
    id: doc._id.toHexString(),
    founderUserId: doc.founderUserId.toHexString(),
    status: doc.status,
    version: doc.version,
    transitionRevision: doc.transitionRevision ?? 0,
    title: doc.title,
    teaser: doc.teaser ?? '',
    problem: doc.problem ?? '',
    solution: doc.solution ?? '',
    industryTags: [...doc.industryTags],
    missionTags: [...doc.missionTags],
    teamSkills: doc.teamSkills.map((s) => ({ skillId: s.skillId, level: s.level })),
    requiredSkills: doc.requiredSkills.map((s) => ({
      skillId: s.skillId,
      level: s.level,
      importance: s.importance,
      mandatory: s.mandatory,
    })),
    hoursRequiredPerWeek: doc.hoursRequiredPerWeek ?? null,
    commitmentMonths: doc.commitmentMonths ?? null,
    mandatoryAvailability: doc.mandatoryAvailability,
    mandatoryCommitment: doc.mandatoryCommitment,
    compensation: {
      type: doc.compensation.type,
      amountMinor: doc.compensation.amountMinor ?? null,
      paymentDueDays: doc.compensation.paymentDueDays ?? null,
      methodNote: doc.compensation.methodNote ?? '',
      benefitDescription: doc.compensation.benefitDescription ?? '',
    },
    publishedAt: doc.publishedAt ?? null,
    closedAt: doc.closedAt ?? null,
    closeReason: doc.closeReason ?? null,
    clonedFromId: doc.clonedFromId ? doc.clonedFromId.toHexString() : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function afterFilter(after: PagePosition | null) {
  if (!after) return {};
  return {
    $or: [
      { createdAt: { $lt: after.createdAt } },
      { createdAt: after.createdAt, _id: { $lt: oid(after.id) } },
    ],
  };
}

/** Server constants written on every new brief (Section 14). */
export const BRIEF_CONSTANTS = {
  roleKey: ROLE_KEY,
  opportunityType: OPPORTUNITY_TYPE,
  workMode: WORK_MODE,
  ipPolicyVersion: VERSIONS.ipPolicy,
} as const;

export function createMongoBriefStore(conn: Connection): BriefStore {
  const { StartupBrief } = briefModels(conn);
  const lean = (q: ReturnType<typeof StartupBrief.findOne>) => q.lean<StartupBriefDoc>().exec();
  const opts = { returnDocument: 'after', runValidators: true } as const;

  return {
    async insertDraft(draft) {
      try {
        const doc = await StartupBrief.create({
          _id: oid(draft.id),
          founderUserId: oid(draft.founderUserId),
          version: 0,
          transitionRevision: 0,
          status: 'draft',
          ...BRIEF_CONSTANTS,
          ...draft.fields,
          publishedAt: null,
          closedAt: null,
          closeReason: null,
          ...(draft.clonedFromId ? { clonedFromId: oid(draft.clonedFromId) } : {}),
        });
        return { record: toBriefRecord(doc.toObject()), created: true };
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        const existing = await lean(StartupBrief.findById(oid(draft.id)));
        if (!existing) throw err;
        return { record: toBriefRecord(existing), created: false };
      }
    },

    async findById(id) {
      const doc = await lean(StartupBrief.findById(oid(id)));
      return doc ? toBriefRecord(doc) : null;
    },

    async listByFounder(founderUserId, page) {
      const docs = await StartupBrief.find({
        founderUserId: oid(founderUserId),
        ...afterFilter(page.after),
      })
        .sort({ createdAt: -1, _id: -1 })
        .limit(page.limit + 1)
        .lean<StartupBriefDoc[]>()
        .exec();
      return docs.map(toBriefRecord);
    },

    async listOpenByFounders(founderUserIds, page) {
      if (founderUserIds.length === 0) return [];
      const docs = await StartupBrief.find({
        status: 'open',
        founderUserId: { $in: founderUserIds.map(oid) },
        ...afterFilter(page.after),
      })
        .sort({ createdAt: -1, _id: -1 })
        .limit(page.limit + 1)
        .lean<StartupBriefDoc[]>()
        .exec();
      return docs.map(toBriefRecord);
    },

    async updateDraft(id, founderUserId, expectedVersion, changes) {
      const doc = await StartupBrief.findOneAndUpdate(
        {
          _id: oid(id),
          founderUserId: oid(founderUserId),
          status: 'draft',
          version: expectedVersion,
        },
        { $set: changes, $inc: { version: 1 } },
        opts,
      )
        .lean<StartupBriefDoc>()
        .exec();
      return doc ? toBriefRecord(doc) : null;
    },

    async publish(id, founderUserId, expectedVersion, normalized, at) {
      const doc = await StartupBrief.findOneAndUpdate(
        {
          _id: oid(id),
          founderUserId: oid(founderUserId),
          status: 'draft',
          version: expectedVersion,
        },
        {
          $set: { ...normalized, status: 'open', version: 1, publishedAt: at },
          $inc: { transitionRevision: 1 },
        },
        opts,
      )
        .lean<StartupBriefDoc>()
        .exec();
      return doc ? toBriefRecord(doc) : null;
    },

    async close(id, founderUserId, reason, at) {
      const doc = await StartupBrief.findOneAndUpdate(
        { _id: oid(id), founderUserId: oid(founderUserId), status: 'open' },
        {
          $set: { status: 'closed', closedAt: at, closeReason: reason },
          $inc: { transitionRevision: 1 },
        },
        opts,
      )
        .lean<StartupBriefDoc>()
        .exec();
      return doc ? toBriefRecord(doc) : null;
    },
  };
}

function toIdempotency(doc: IdempotencyRecordDoc): IdempotencyRecord {
  return {
    actorUserId: doc.actorUserId.toHexString(),
    route: doc.route,
    key: doc.key,
    bodyHash: doc.bodyHash,
    resourceId: doc.resourceId,
    responseStatus: doc.responseStatus ?? null,
    expiresAt: doc.expiresAt,
  };
}

export function createMongoIdempotencyStore(conn: Connection): IdempotencyStore {
  const { IdempotencyRecord } = briefModels(conn);
  return {
    async reserve(record) {
      try {
        await IdempotencyRecord.create({ ...record, actorUserId: oid(record.actorUserId) });
        return { reserved: true };
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        const existing = await IdempotencyRecord.findOne({
          actorUserId: oid(record.actorUserId),
          route: record.route,
          key: record.key,
        })
          .lean<IdempotencyRecordDoc>()
          .exec();
        if (!existing) throw err;
        return { reserved: false, existing: toIdempotency(existing) };
      }
    },

    async complete(actorUserId, route, key, responseStatus) {
      await IdempotencyRecord.updateOne(
        { actorUserId: oid(actorUserId), route, key },
        { $set: { responseStatus } },
      ).exec();
    },

    async release(actorUserId, route, key) {
      await IdempotencyRecord.deleteOne({ actorUserId: oid(actorUserId), route, key }).exec();
    },

    async purgeExpired(now) {
      const res = await IdempotencyRecord.deleteMany({ expiresAt: { $lte: now } }).exec();
      return res.deletedCount;
    },
  };
}
