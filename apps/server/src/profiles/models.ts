import mongoose, { type Connection, type Model, type Types } from 'mongoose';
import { INDUSTRY_TAGS, MISSION_TAGS, SKILL_IDS } from '@cofoundry/shared';
import type { EvidenceStatus, IndustryTag, MissionTag, SkillId } from '@cofoundry/shared';

/**
 * Section 14 persistence for profiles and consent. Indexes come from migration 3.
 * Server-owned fields (userId, revision, evidenceStatus, timestamps) are never taken from
 * request bodies.
 */

export interface ProjectDoc {
  _id: Types.ObjectId;
  title: string;
  description: string;
  skillTags: SkillId[];
  url: string | null;
  evidenceStatus: EvidenceStatus;
}

export interface CandidateProfileDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  revision: number;
  headline: string;
  bio: string;
  skills: Array<{ skillId: SkillId; level: number }>;
  industryTags: IndustryTag[];
  missionTags: MissionTag[];
  availableHoursPerWeek: number | null;
  commitmentMonths: number | null;
  opportunityTypes: Array<'contributor'>;
  projects: ProjectDoc[];
  discoveryEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface FounderProfileDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  revision: number;
  bio: string;
  companyUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Section 14 purposes plus resume_processing (Phase 4 amendment: resume upload consent). */
export const CONSENT_PURPOSES = [
  'profile_discovery',
  'assessment',
  'brief_access',
  'resume_processing',
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export interface ConsentRecordDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  purpose: ConsentPurpose;
  targetId: Types.ObjectId;
  policyVersion: string;
  grantedAt: Date;
  withdrawnAt: Date | null;
  /**
   * Storage-internal uniqueness key, present only while the record is active (unset on
   * withdrawal). A unique sparse index on it enforces "one active record per
   * user/purpose/target" on every MongoDB version without partial-index support.
   */
  activeKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

export function consentActiveKey(
  userId: string,
  purpose: ConsentPurpose,
  targetId: string,
): string {
  return `${purpose}:${userId}:${targetId}`;
}

const projectSchema = new mongoose.Schema<ProjectDoc>(
  {
    title: { type: String, required: true, minlength: 1, maxlength: 100 },
    description: { type: String, required: true, minlength: 50, maxlength: 1500 },
    skillTags: { type: [{ type: String, enum: SKILL_IDS }], required: true },
    url: { type: String, default: null },
    evidenceStatus: { type: String, enum: ['self_reported', 'project_linked'], required: true },
  },
  { _id: true, strict: 'throw' },
);

const candidateSchema = new mongoose.Schema<CandidateProfileDoc>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    revision: { type: Number, required: true, min: 1 },
    headline: { type: String, default: '', maxlength: 160 },
    bio: { type: String, default: '', maxlength: 1000 },
    skills: {
      type: [
        new mongoose.Schema(
          {
            skillId: { type: String, enum: SKILL_IDS, required: true },
            level: { type: Number, required: true, min: 1, max: 5 },
          },
          { _id: false, strict: 'throw' },
        ),
      ],
      default: [],
    },
    industryTags: { type: [{ type: String, enum: INDUSTRY_TAGS }], default: [] },
    missionTags: { type: [{ type: String, enum: MISSION_TAGS }], default: [] },
    availableHoursPerWeek: { type: Number, default: null, min: 1, max: 40 },
    commitmentMonths: { type: Number, default: null, min: 1, max: 12 },
    opportunityTypes: { type: [{ type: String, enum: ['contributor'] }], default: [] },
    projects: { type: [projectSchema], default: [] },
    discoveryEnabled: { type: Boolean, required: true, default: false },
  },
  { collection: 'candidate_profiles', timestamps: true, strict: 'throw', versionKey: false },
);

const founderSchema = new mongoose.Schema<FounderProfileDoc>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    revision: { type: Number, required: true, min: 1 },
    bio: { type: String, default: '', maxlength: 1000 },
    companyUrl: { type: String, default: null },
  },
  { collection: 'founder_profiles', timestamps: true, strict: 'throw', versionKey: false },
);

const consentSchema = new mongoose.Schema<ConsentRecordDoc>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    purpose: { type: String, enum: CONSENT_PURPOSES, required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
    policyVersion: { type: String, required: true },
    grantedAt: { type: Date, required: true },
    withdrawnAt: { type: Date, default: null },
    activeKey: { type: String },
  },
  { collection: 'consent_records', timestamps: true, strict: 'throw', versionKey: false },
);

export interface ProfileModels {
  CandidateProfile: Model<CandidateProfileDoc>;
  FounderProfile: Model<FounderProfileDoc>;
  ConsentRecord: Model<ConsentRecordDoc>;
}

function model<T>(conn: Connection, name: string, schema: mongoose.Schema<T>): Model<T> {
  return (conn.models[name] as Model<T> | undefined) ?? conn.model<T>(name, schema);
}

export function profileModels(conn: Connection): ProfileModels {
  return {
    CandidateProfile: model(conn, 'CandidateProfile', candidateSchema),
    FounderProfile: model(conn, 'FounderProfile', founderSchema),
    ConsentRecord: model(conn, 'ConsentRecord', consentSchema),
  };
}
