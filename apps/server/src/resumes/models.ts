import mongoose, { type Connection, type Model, type Types } from 'mongoose';
import { RESUME_EXTRACTION_STATUSES, RESUME_LIMITS } from '@cofoundry/shared';
import type { ResumeExtractionStatus } from '@cofoundry/shared';

/**
 * Candidate resume (Phase 4 amendment). One document per candidate: `version` is the last
 * version number issued (kept after deletion so numbers are never reused); `current` is the live
 * resume or null. The extracted text lives in the same document but is excluded from metadata
 * reads; the original file is in ResumeFileStorage under a random key.
 */
export interface CurrentResumeDoc {
  storageKey: string;
  filename: string;
  sizeBytes: number;
  fileSha256: string;
  uploadedAt: Date;
  extraction: {
    status: ResumeExtractionStatus;
    extractorVersion: string;
    pageCount: number;
    pagesProcessed: number;
    textChars: number;
    truncated: boolean;
    textSha256: string;
    extractedAt: Date;
  };
  extractedText: string;
}

export interface CandidateResumeDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  version: number;
  current: CurrentResumeDoc | null;
  createdAt: Date;
  updatedAt: Date;
}

const strict = { _id: false, strict: 'throw' as const };

const currentSchema = new mongoose.Schema<CurrentResumeDoc>(
  {
    storageKey: { type: String, required: true, match: /^[a-f0-9]{32}$/ },
    filename: { type: String, required: true, maxlength: RESUME_LIMITS.filenameMax },
    sizeBytes: { type: Number, required: true, min: 1, max: RESUME_LIMITS.maxBytes },
    fileSha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    uploadedAt: { type: Date, required: true },
    extraction: {
      type: new mongoose.Schema(
        {
          status: { type: String, enum: RESUME_EXTRACTION_STATUSES, required: true },
          extractorVersion: { type: String, required: true },
          pageCount: { type: Number, required: true, min: 0 },
          pagesProcessed: { type: Number, required: true, min: 0 },
          textChars: { type: Number, required: true, min: 0 },
          truncated: { type: Boolean, required: true },
          textSha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
          extractedAt: { type: Date, required: true },
        },
        strict,
      ),
      required: true,
    },
    extractedText: { type: String, default: '', maxlength: RESUME_LIMITS.maxTextChars * 2 },
  },
  strict,
);

const resumeSchema = new mongoose.Schema<CandidateResumeDoc>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true, min: 1 },
    current: { type: currentSchema, default: null },
  },
  { collection: 'candidate_resumes', timestamps: true, strict: 'throw', versionKey: false },
);

export function resumeModel(conn: Connection): Model<CandidateResumeDoc> {
  return (
    (conn.models.CandidateResume as Model<CandidateResumeDoc> | undefined) ??
    conn.model<CandidateResumeDoc>('CandidateResume', resumeSchema)
  );
}
