import mongoose, { type Connection } from 'mongoose';
import type { EvidenceStatus, IndustryTag, MissionTag, SkillId } from '@cofoundry/shared';
import {
  consentActiveKey,
  profileModels,
  type CandidateProfileDoc,
  type ConsentPurpose,
  type FounderProfileDoc,
} from './models.js';

export interface ProjectRecord {
  id: string;
  title: string;
  description: string;
  skillTags: SkillId[];
  url: string | null;
  evidenceStatus: EvidenceStatus;
}

export interface CandidateProfileFields {
  headline: string;
  bio: string;
  skills: Array<{ skillId: SkillId; level: number }>;
  industryTags: IndustryTag[];
  missionTags: MissionTag[];
  availableHoursPerWeek: number | null;
  commitmentMonths: number | null;
  opportunityTypes: Array<'contributor'>;
  projects: ProjectRecord[];
  discoveryEnabled: boolean;
}

export interface CandidateProfileRecord extends CandidateProfileFields {
  userId: string;
  revision: number;
  updatedAt: Date;
}

export interface FounderProfileFields {
  bio: string;
  companyUrl: string | null;
}

export interface FounderProfileRecord extends FounderProfileFields {
  userId: string;
  revision: number;
  updatedAt: Date;
}

export interface ConsentKey {
  userId: string;
  purpose: ConsentPurpose;
  targetId: string;
}

/**
 * Persistence port for profiles. Each method is one atomic single-document write.
 * `save*` methods use optimistic concurrency: they succeed only when the stored revision equals
 * `expectedRevision` (0 = create) and return 'conflict' otherwise.
 */
export interface ProfileStore {
  findCandidate(userId: string): Promise<CandidateProfileRecord | null>;
  saveCandidate(
    userId: string,
    expectedRevision: number,
    fields: CandidateProfileFields,
  ): Promise<CandidateProfileRecord | 'conflict'>;
  findFounder(userId: string): Promise<FounderProfileRecord | null>;
  saveFounder(
    userId: string,
    expectedRevision: number,
    fields: FounderProfileFields,
  ): Promise<FounderProfileRecord | 'conflict'>;
  hasActiveConsent(key: ConsentKey): Promise<boolean>;
  /** Idempotent: does nothing when an active record already exists. */
  grantConsent(key: ConsentKey, policyVersion: string, at: Date): Promise<void>;
  /** Marks every active record for the key withdrawn; returns how many were withdrawn. */
  withdrawConsent(key: ConsentKey, at: Date): Promise<number>;
}

const oid = (id: string) => new mongoose.Types.ObjectId(id);

function toCandidate(doc: CandidateProfileDoc): CandidateProfileRecord {
  return {
    userId: doc.userId.toHexString(),
    revision: doc.revision,
    headline: doc.headline ?? '',
    bio: doc.bio ?? '',
    skills: doc.skills.map((s) => ({ skillId: s.skillId, level: s.level })),
    industryTags: [...doc.industryTags],
    missionTags: [...doc.missionTags],
    availableHoursPerWeek: doc.availableHoursPerWeek ?? null,
    commitmentMonths: doc.commitmentMonths ?? null,
    opportunityTypes: [...doc.opportunityTypes],
    projects: doc.projects.map((p) => ({
      id: p._id.toHexString(),
      title: p.title,
      description: p.description,
      skillTags: [...p.skillTags],
      url: p.url ?? null,
      evidenceStatus: p.evidenceStatus,
    })),
    discoveryEnabled: doc.discoveryEnabled,
    updatedAt: doc.updatedAt,
  };
}

function toFounder(doc: FounderProfileDoc): FounderProfileRecord {
  return {
    userId: doc.userId.toHexString(),
    revision: doc.revision,
    bio: doc.bio ?? '',
    companyUrl: doc.companyUrl ?? null,
    updatedAt: doc.updatedAt,
  };
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

function candidateSet(fields: CandidateProfileFields) {
  return {
    ...fields,
    projects: fields.projects.map((p) => ({
      _id: oid(p.id),
      title: p.title,
      description: p.description,
      skillTags: p.skillTags,
      url: p.url,
      evidenceStatus: p.evidenceStatus,
    })),
  };
}

export function createMongoProfileStore(conn: Connection): ProfileStore {
  const { CandidateProfile, FounderProfile, ConsentRecord } = profileModels(conn);

  return {
    async findCandidate(userId) {
      const doc = await CandidateProfile.findOne({ userId: oid(userId) })
        .lean<CandidateProfileDoc>()
        .exec();
      return doc ? toCandidate(doc) : null;
    },

    async saveCandidate(userId, expectedRevision, fields) {
      if (expectedRevision === 0) {
        try {
          const doc = await CandidateProfile.create({
            userId: oid(userId),
            revision: 1,
            ...candidateSet(fields),
          });
          return toCandidate(doc.toObject());
        } catch (err) {
          if (isDuplicateKey(err)) return 'conflict';
          throw err;
        }
      }
      const doc = await CandidateProfile.findOneAndUpdate(
        { userId: oid(userId), revision: expectedRevision },
        { $set: { ...candidateSet(fields), revision: expectedRevision + 1 } },
        { new: true, runValidators: true },
      )
        .lean<CandidateProfileDoc>()
        .exec();
      return doc ? toCandidate(doc) : 'conflict';
    },

    async findFounder(userId) {
      const doc = await FounderProfile.findOne({ userId: oid(userId) })
        .lean<FounderProfileDoc>()
        .exec();
      return doc ? toFounder(doc) : null;
    },

    async saveFounder(userId, expectedRevision, fields) {
      if (expectedRevision === 0) {
        try {
          const doc = await FounderProfile.create({ userId: oid(userId), revision: 1, ...fields });
          return toFounder(doc.toObject());
        } catch (err) {
          if (isDuplicateKey(err)) return 'conflict';
          throw err;
        }
      }
      const doc = await FounderProfile.findOneAndUpdate(
        { userId: oid(userId), revision: expectedRevision },
        { $set: { ...fields, revision: expectedRevision + 1 } },
        { new: true, runValidators: true },
      )
        .lean<FounderProfileDoc>()
        .exec();
      return doc ? toFounder(doc) : 'conflict';
    },

    async hasActiveConsent(key) {
      const found = await ConsentRecord.exists({
        userId: oid(key.userId),
        purpose: key.purpose,
        targetId: oid(key.targetId),
        withdrawnAt: null,
      });
      return Boolean(found);
    },

    async grantConsent(key, policyVersion, at) {
      const activeKey = consentActiveKey(key.userId, key.purpose, key.targetId);
      try {
        await ConsentRecord.updateOne(
          { activeKey },
          {
            $setOnInsert: {
              userId: oid(key.userId),
              purpose: key.purpose,
              targetId: oid(key.targetId),
              policyVersion,
              grantedAt: at,
              withdrawnAt: null,
            },
          },
          { upsert: true },
        ).exec();
      } catch (err) {
        // A concurrent grant created the active record first: the outcome is the same.
        if (!isDuplicateKey(err)) throw err;
      }
    },

    async withdrawConsent(key, at) {
      const res = await ConsentRecord.updateMany(
        {
          userId: oid(key.userId),
          purpose: key.purpose,
          targetId: oid(key.targetId),
          withdrawnAt: null,
        },
        { $set: { withdrawnAt: at }, $unset: { activeKey: '' } },
      ).exec();
      return res.modifiedCount;
    },
  };
}
