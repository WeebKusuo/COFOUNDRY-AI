import mongoose, { type Connection } from 'mongoose';
import type { GateCode, RecommendationEntry } from '@cofoundry/shared';
import type { MATCH_ALGORITHM_VERSION } from '@cofoundry/shared';
import { recommendationModel, type RecommendationBatchDoc } from './models.js';

export interface RecommendationBatchRecord {
  id: string;
  briefId: string;
  briefVersion: number;
  founderUserId: string;
  algorithmVersion: typeof MATCH_ALGORITHM_VERSION;
  generatedAt: Date;
  expiresAt: Date;
  totalExcluded: number;
  gateCounts: Array<{ code: GateCode; count: number }>;
  entries: RecommendationEntry[];
  entriesPurgedAt: Date | null;
}

export interface RecommendationStore {
  /** Inserts with a pre-generated id; an existing id returns the stored batch (idempotent retry). */
  insert(batch: RecommendationBatchRecord): Promise<RecommendationBatchRecord>;
  findById(id: string): Promise<RecommendationBatchRecord | null>;
  /** Most recent batch for a brief (generatedAt, then id, descending). */
  findLatestForBrief(briefId: string): Promise<RecommendationBatchRecord | null>;
  /** Section 24: remove personal entries from batches generated before `cutoff`. */
  purgeEntriesBefore(cutoff: Date, at: Date): Promise<number>;
}

const oid = (id: string) => new mongoose.Types.ObjectId(id);

function toRecord(doc: RecommendationBatchDoc): RecommendationBatchRecord {
  return {
    id: doc._id.toHexString(),
    briefId: doc.briefId.toHexString(),
    briefVersion: doc.briefVersion,
    founderUserId: doc.founderUserId.toHexString(),
    algorithmVersion: doc.algorithmVersion,
    generatedAt: doc.generatedAt,
    expiresAt: doc.expiresAt,
    totalExcluded: doc.totalExcluded,
    gateCounts: doc.gateCounts.map((g) => ({ code: g.code, count: g.count })),
    entries: doc.entries ?? [],
    entriesPurgedAt: doc.entriesPurgedAt ?? null,
  };
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

export function createMongoRecommendationStore(conn: Connection): RecommendationStore {
  const Batch = recommendationModel(conn);
  return {
    async insert(batch) {
      const { id, briefId, founderUserId, ...rest } = batch;
      try {
        const doc = await Batch.create({
          _id: oid(id),
          briefId: oid(briefId),
          founderUserId: oid(founderUserId),
          ...rest,
        });
        return toRecord(doc.toObject());
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        const existing = await Batch.findById(oid(id)).lean<RecommendationBatchDoc>().exec();
        if (!existing) throw err;
        return toRecord(existing);
      }
    },
    async findById(id) {
      const doc = await Batch.findById(oid(id)).lean<RecommendationBatchDoc>().exec();
      return doc ? toRecord(doc) : null;
    },
    async findLatestForBrief(briefId) {
      const doc = await Batch.findOne({ briefId: oid(briefId) })
        .sort({ generatedAt: -1, _id: -1 })
        .lean<RecommendationBatchDoc>()
        .exec();
      return doc ? toRecord(doc) : null;
    },
    async purgeEntriesBefore(cutoff, at) {
      const res = await Batch.updateMany(
        { generatedAt: { $lt: cutoff }, entriesPurgedAt: null },
        { $set: { entries: [], entriesPurgedAt: at } },
      ).exec();
      return res.modifiedCount;
    },
  };
}
