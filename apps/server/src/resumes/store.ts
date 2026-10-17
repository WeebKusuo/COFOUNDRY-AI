import mongoose, { type Connection } from 'mongoose';
import type { ResumeExtractionStatus } from '@cofoundry/shared';
import { resumeModel, type CandidateResumeDoc, type CurrentResumeDoc } from './models.js';

export interface CurrentResume {
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
}

export interface ResumeRecord {
  userId: string;
  /** Last version issued (0 when the candidate never uploaded). */
  version: number;
  current: CurrentResume | null;
}

export interface ResumeText {
  version: number;
  current: CurrentResume;
  text: string;
}

/**
 * Persistence port for resume metadata and extracted text. Writes are single conditional
 * document updates: `save` succeeds only when the stored version equals expectedVersion.
 */
export interface ResumeStore {
  find(userId: string): Promise<ResumeRecord | null>;
  findWithText(userId: string): Promise<ResumeText | null>;
  /** Returns the storage key of the replaced file (to delete), or 'conflict'. */
  save(
    userId: string,
    expectedVersion: number,
    current: CurrentResume,
    text: string,
  ): Promise<{ record: ResumeRecord; replacedStorageKey: string | null } | 'conflict'>;
  /**
   * Removes the live resume and its text and increments the version; returns the removed storage
   * key, or null if none.
   */
  clear(userId: string): Promise<string | null>;
}

const oid = (id: string) => new mongoose.Types.ObjectId(id);

function toCurrent(doc: CurrentResumeDoc): CurrentResume {
  return {
    storageKey: doc.storageKey,
    filename: doc.filename,
    sizeBytes: doc.sizeBytes,
    fileSha256: doc.fileSha256,
    uploadedAt: doc.uploadedAt,
    extraction: { ...doc.extraction },
  };
}

function toRecord(doc: CandidateResumeDoc): ResumeRecord {
  return {
    userId: doc.userId.toHexString(),
    version: doc.version,
    current: doc.current ? toCurrent(doc.current) : null,
  };
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

const WITHOUT_TEXT = { 'current.extractedText': 0 } as const;

export function createMongoResumeStore(conn: Connection): ResumeStore {
  const Resume = resumeModel(conn);
  return {
    async find(userId) {
      const doc = await Resume.findOne({ userId: oid(userId) }, WITHOUT_TEXT)
        .lean<CandidateResumeDoc>()
        .exec();
      return doc ? toRecord(doc) : null;
    },

    async findWithText(userId) {
      const doc = await Resume.findOne({ userId: oid(userId) })
        .lean<CandidateResumeDoc>()
        .exec();
      if (!doc?.current) return null;
      return {
        version: doc.version,
        current: toCurrent(doc.current),
        text: doc.current.extractedText ?? '',
      };
    },

    async save(userId, expectedVersion, current, text) {
      const value = { ...current, extractedText: text };
      if (expectedVersion === 0) {
        try {
          const doc = await Resume.create({ userId: oid(userId), version: 1, current: value });
          return { record: toRecord(doc.toObject()), replacedStorageKey: null };
        } catch (err) {
          if (isDuplicateKey(err)) return 'conflict';
          throw err;
        }
      }
      // Pre-image: the replaced file's key is read atomically with the update.
      const before = await Resume.findOneAndUpdate(
        { userId: oid(userId), version: expectedVersion },
        { $set: { version: expectedVersion + 1, current: value } },
        // No projection: findAndModify projections are not portable (FerretDB); the pre-image
        // stays inside this function and only its storage key is used.
        { returnDocument: 'before', runValidators: true },
      )
        .lean<CandidateResumeDoc>()
        .exec();
      if (!before) return 'conflict';
      return {
        record: { userId, version: expectedVersion + 1, current },
        replacedStorageKey: before.current?.storageKey ?? null,
      };
    },

    async clear(userId) {
      const before = await Resume.findOneAndUpdate(
        { userId: oid(userId), current: { $ne: null } },
        // Deletion also issues a new version, so an upload started against the old version
        // (e.g. in another tab) conflicts instead of resurrecting a resume without consent.
        { $set: { current: null }, $inc: { version: 1 } },
        { returnDocument: 'before' },
      )
        .lean<CandidateResumeDoc>()
        .exec();
      return before?.current?.storageKey ?? null;
    },
  };
}
