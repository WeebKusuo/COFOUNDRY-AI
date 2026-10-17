import mongoose, { type Connection, type Model, type Types } from 'mongoose';
import {
  BRIEF_LIMITS as L,
  BRIEF_STATUSES,
  COMPENSATION_TYPES,
  INDUSTRY_TAGS,
  MISSION_TAGS,
  OPPORTUNITY_TYPE,
  ROLE_KEY,
  SKILL_IDS,
  VERSIONS,
  WORK_MODE,
} from '@cofoundry/shared';
import type {
  BriefStatus,
  CompensationType,
  IndustryTag,
  MissionTag,
  SkillId,
} from '@cofoundry/shared';

/**
 * Section 14 StartupBrief. Indexes come from migration 4. Role, opportunity, work mode and IP
 * policy are server constants; version, transitionRevision, status and timestamps are
 * server-owned and never taken from request bodies.
 */
export interface StartupBriefDoc {
  _id: Types.ObjectId;
  founderUserId: Types.ObjectId;
  /** Draft: 0, +1 per edit. Published: 1 (snapshot reset). */
  version: number;
  /** Incremented by every status transition; later relationship writes guard on it (Section 25). */
  transitionRevision: number;
  status: BriefStatus;
  roleKey: typeof ROLE_KEY;
  opportunityType: typeof OPPORTUNITY_TYPE;
  workMode: typeof WORK_MODE;
  title: string;
  teaser: string;
  problem: string;
  solution: string;
  industryTags: IndustryTag[];
  missionTags: MissionTag[];
  teamSkills: Array<{ skillId: SkillId; level: number }>;
  requiredSkills: Array<{
    skillId: SkillId;
    level: number;
    importance: number;
    mandatory: boolean;
  }>;
  hoursRequiredPerWeek: number | null;
  commitmentMonths: number | null;
  mandatoryAvailability: boolean;
  mandatoryCommitment: boolean;
  compensation: {
    type: CompensationType;
    amountMinor: number | null;
    paymentDueDays: number | null;
    methodNote: string;
    benefitDescription: string;
  };
  ipPolicyVersion: typeof VERSIONS.ipPolicy;
  publishedAt: Date | null;
  closedAt: Date | null;
  /** The reason accepted by POST /startups/:id/close (0-500 chars). */
  closeReason: string | null;
  clonedFromId?: Types.ObjectId;
  /** Storage-internal: identifies seeded demo briefs (Section 26 idempotent seeding). */
  seedKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Section 16 IdempotencyRecord (retained 24 h; purged by the sweeper). */
export interface IdempotencyRecordDoc {
  _id: Types.ObjectId;
  actorUserId: Types.ObjectId;
  route: string;
  key: string;
  bodyHash: string;
  resourceId: string;
  /** Null while the first attempt is in flight (or crashed before completing). */
  responseStatus: number | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const strict = { _id: false, strict: 'throw' as const };

const briefSchema = new mongoose.Schema<StartupBriefDoc>(
  {
    founderUserId: { type: mongoose.Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true, min: 0 },
    transitionRevision: { type: Number, required: true, min: 0, default: 0 },
    status: { type: String, enum: BRIEF_STATUSES, required: true },
    roleKey: { type: String, enum: [ROLE_KEY], required: true },
    opportunityType: { type: String, enum: [OPPORTUNITY_TYPE], required: true },
    workMode: { type: String, enum: [WORK_MODE], required: true },
    title: { type: String, required: true, minlength: 1, maxlength: L.titleMax },
    teaser: { type: String, default: '', maxlength: L.teaserMax },
    problem: { type: String, default: '', maxlength: L.problemMax },
    solution: { type: String, default: '', maxlength: L.solutionMax },
    industryTags: { type: [{ type: String, enum: INDUSTRY_TAGS }], default: [] },
    missionTags: { type: [{ type: String, enum: MISSION_TAGS }], default: [] },
    teamSkills: {
      type: [
        new mongoose.Schema(
          {
            skillId: { type: String, enum: SKILL_IDS, required: true },
            level: { type: Number, required: true, min: L.teamLevelMin, max: L.teamLevelMax },
          },
          strict,
        ),
      ],
      default: [],
    },
    requiredSkills: {
      type: [
        new mongoose.Schema(
          {
            skillId: { type: String, enum: SKILL_IDS, required: true },
            level: {
              type: Number,
              required: true,
              min: L.requiredLevelMin,
              max: L.requiredLevelMax,
            },
            importance: {
              type: Number,
              required: true,
              min: L.importanceMin,
              max: L.importanceMax,
            },
            mandatory: { type: Boolean, required: true },
          },
          strict,
        ),
      ],
      default: [],
    },
    hoursRequiredPerWeek: { type: Number, default: null, min: L.hoursMin, max: L.hoursMax },
    commitmentMonths: { type: Number, default: null, min: L.monthsMin, max: L.monthsMax },
    mandatoryAvailability: { type: Boolean, required: true, default: false },
    mandatoryCommitment: { type: Boolean, required: true, default: false },
    compensation: {
      type: new mongoose.Schema(
        {
          type: { type: String, enum: COMPENSATION_TYPES, required: true },
          amountMinor: { type: Number, default: null, min: 1 },
          paymentDueDays: {
            type: Number,
            default: null,
            min: L.paymentDueDaysMin,
            max: L.paymentDueDaysMax,
          },
          methodNote: { type: String, default: '', maxlength: L.methodNoteMax },
          benefitDescription: { type: String, default: '', maxlength: L.benefitDescriptionMax },
        },
        strict,
      ),
      required: true,
    },
    ipPolicyVersion: { type: String, enum: [VERSIONS.ipPolicy], required: true },
    publishedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    closeReason: { type: String, default: null, maxlength: L.closeReasonMax },
    clonedFromId: { type: mongoose.Schema.Types.ObjectId },
    seedKey: { type: String },
  },
  { collection: 'startup_briefs', timestamps: true, strict: 'throw', versionKey: false },
);

const idempotencySchema = new mongoose.Schema<IdempotencyRecordDoc>(
  {
    actorUserId: { type: mongoose.Schema.Types.ObjectId, required: true },
    route: { type: String, required: true, maxlength: 200 },
    key: { type: String, required: true, maxlength: 64 },
    bodyHash: { type: String, required: true },
    resourceId: { type: String, required: true },
    responseStatus: { type: Number, default: null },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'idempotency_records', timestamps: true, strict: 'throw', versionKey: false },
);

export interface BriefModels {
  StartupBrief: Model<StartupBriefDoc>;
  IdempotencyRecord: Model<IdempotencyRecordDoc>;
}

function model<T>(conn: Connection, name: string, schema: mongoose.Schema<T>): Model<T> {
  return (conn.models[name] as Model<T> | undefined) ?? conn.model<T>(name, schema);
}

export function briefModels(conn: Connection): BriefModels {
  return {
    StartupBrief: model(conn, 'StartupBrief', briefSchema),
    IdempotencyRecord: model(conn, 'IdempotencyRecord', idempotencySchema),
  };
}
