import mongoose, { type Connection, type Model, type Types } from 'mongoose';
import { GATE_CODES, MATCH_ALGORITHM_VERSION } from '@cofoundry/shared';
import type { GateCode, RecommendationEntry } from '@cofoundry/shared';

/**
 * Section 15 RecommendationBatch. Entries are the computed match snapshot (scores, components,
 * explanations and each candidate's profileRevision) — never profile text, contact data, resume
 * data or brief content. Entries are removed after 24 hours (Section 24) while the batch record
 * stays referenceable by id.
 */
export interface RecommendationBatchDoc {
  _id: Types.ObjectId;
  briefId: Types.ObjectId;
  briefVersion: number;
  founderUserId: Types.ObjectId;
  algorithmVersion: typeof MATCH_ALGORITHM_VERSION;
  generatedAt: Date;
  expiresAt: Date;
  totalExcluded: number;
  gateCounts: Array<{ code: GateCode; count: number }>;
  entries: RecommendationEntry[];
  /** Set when the 24-hour retention job removed the personal entries. */
  entriesPurgedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const batchSchema = new mongoose.Schema<RecommendationBatchDoc>(
  {
    briefId: { type: mongoose.Schema.Types.ObjectId, required: true },
    briefVersion: { type: Number, required: true, min: 1 },
    founderUserId: { type: mongoose.Schema.Types.ObjectId, required: true },
    algorithmVersion: { type: String, enum: [MATCH_ALGORITHM_VERSION], required: true },
    generatedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    totalExcluded: { type: Number, required: true, min: 0 },
    gateCounts: {
      type: [
        new mongoose.Schema(
          {
            code: { type: String, enum: GATE_CODES, required: true },
            count: { type: Number, required: true, min: 0 },
          },
          { _id: false, strict: 'throw' },
        ),
      ],
      required: true,
    },
    // Validated by the engine's types; stored as plain sub-documents (bounded to 9 entries).
    entries: { type: mongoose.Schema.Types.Mixed, default: [] },
    entriesPurgedAt: { type: Date, default: null },
  },
  { collection: 'recommendation_batches', timestamps: true, strict: 'throw', versionKey: false },
);

export function recommendationModel(conn: Connection): Model<RecommendationBatchDoc> {
  return (
    (conn.models.RecommendationBatch as Model<RecommendationBatchDoc> | undefined) ??
    conn.model<RecommendationBatchDoc>('RecommendationBatch', batchSchema)
  );
}
