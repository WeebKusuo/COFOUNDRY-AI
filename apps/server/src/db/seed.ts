import mongoose, { type Connection } from 'mongoose';
import {
  PROFILE_DISCLOSURE_POLICY_VERSION,
  briefPublishGaps,
  hasSkillGap,
} from '@cofoundry/shared';
import { briefModels } from '../briefs/models.js';
import { BRIEF_CONSTANTS } from '../briefs/store.js';
import { resumeModel } from '../resumes/models.js';
import { assertPasswordPolicy, hashPassword, verifyPassword } from '../auth/crypto.js';
import { identityModels } from '../auth/models.js';
import type { Logger } from '../lib/logger.js';
import { consentActiveKey, profileModels } from '../profiles/models.js';
import {
  DEMO_ACCOUNTS,
  DEMO_BRIEFS,
  DEMO_CANDIDATE_PROFILES,
  DEMO_COHORT_ID,
  DEMO_FOUNDER_PROFILES,
  type DemoAccount,
} from './demo-accounts.js';
import { getMigrationStatus } from './migrations.js';

export class SeedRefusedError extends Error {}

export interface SeedOptions {
  demoMode: boolean;
  password: string;
  /** Delete all demo accounts (and their sessions) first. Requires explicit confirmation. */
  reset?: boolean;
  accounts?: readonly DemoAccount[];
  /** Removes a stored resume file on reset (resume originals live outside MongoDB). */
  deleteResumeFile?: (storageKey: string) => Promise<void>;
}

export interface SeedSummary {
  created: string[];
  updated: string[];
  unchanged: string[];
  removed: number;
  profilesCreated: number;
  briefsCreated: number;
}

/**
 * Idempotent demo seeding by seedKey (Section 26). Refuses outside DEMO_MODE and refuses any
 * database that holds pilot accounts. Re-running produces the same state; a changed demo password
 * re-hashes and bumps authVersion so old sessions stop working.
 */
export async function seedDemoAccounts(
  conn: Connection,
  logger: Logger,
  options: SeedOptions,
): Promise<SeedSummary> {
  if (!options.demoMode) {
    throw new SeedRefusedError('Seeding is only allowed with DEMO_MODE=true.');
  }
  assertPasswordPolicy(options.password);
  const migrations = await getMigrationStatus(conn);
  if (!migrations.upToDate) {
    throw new SeedRefusedError(`Run migrations first (pending: ${migrations.pending.join(', ')}).`);
  }

  const { User, Session } = identityModels(conn);
  if (await User.exists({ accountMode: 'pilot' })) {
    throw new SeedRefusedError('This database contains pilot accounts; demo seeding is refused.');
  }

  const summary: SeedSummary = {
    created: [],
    updated: [],
    unchanged: [],
    removed: 0,
    profilesCreated: 0,
    briefsCreated: 0,
  };
  const { CandidateProfile, FounderProfile, ConsentRecord } = profileModels(conn);

  if (options.reset) {
    const demoUsers = await User.find({ accountMode: 'demo' }, { _id: 1 }).lean().exec();
    const ids = demoUsers.map((u) => u._id);
    await Session.deleteMany({ userId: { $in: ids } }).exec();
    await CandidateProfile.deleteMany({ userId: { $in: ids } }).exec();
    await FounderProfile.deleteMany({ userId: { $in: ids } }).exec();
    await ConsentRecord.deleteMany({ userId: { $in: ids } }).exec();
    const { StartupBrief, IdempotencyRecord } = briefModels(conn);
    await StartupBrief.deleteMany({ founderUserId: { $in: ids } }).exec();
    await IdempotencyRecord.deleteMany({ actorUserId: { $in: ids } }).exec();
    const Resume = resumeModel(conn);
    const resumes = await Resume.find(
      { userId: { $in: ids }, current: { $ne: null } },
      { 'current.storageKey': 1 },
    )
      .lean<Array<{ current: { storageKey?: string } | null }>>()
      .exec();
    for (const r of resumes) {
      if (r.current?.storageKey) await options.deleteResumeFile?.(r.current.storageKey);
    }
    await Resume.deleteMany({ userId: { $in: ids } }).exec();
    const res = await User.deleteMany({ _id: { $in: ids } }).exec();
    summary.removed = res.deletedCount;
    logger.info({ removed: summary.removed }, 'demo accounts removed');
  }

  for (const account of options.accounts ?? DEMO_ACCOUNTS) {
    const emailLower = account.email.toLowerCase();
    const existing = await User.findOne({ seedKey: account.seedKey }).exec();
    if (!existing) {
      await User.create({
        seedKey: account.seedKey,
        emailLower,
        passwordHash: await hashPassword(options.password),
        displayName: account.displayName,
        roles: account.roles,
        cohortId: DEMO_COHORT_ID,
        status: 'active',
        accountMode: 'demo',
        authVersion: 1,
        emailVerifiedAt: null,
      });
      summary.created.push(emailLower);
      continue;
    }

    let changed = false;
    const set = (key: 'emailLower' | 'displayName' | 'cohortId', value: string) => {
      if (existing.get(key) !== value) {
        existing.set(key, value);
        changed = true;
      }
    };
    set('emailLower', emailLower);
    set('displayName', account.displayName);
    set('cohortId', DEMO_COHORT_ID);
    if ([...existing.roles].sort().join() !== [...account.roles].sort().join()) {
      existing.roles = [...account.roles];
      existing.authVersion += 1;
      changed = true;
    }
    if (existing.status !== 'active' || existing.accountMode !== 'demo') {
      existing.status = 'active';
      existing.accountMode = 'demo';
      changed = true;
    }
    if (existing.emailVerifiedAt !== null) {
      existing.emailVerifiedAt = null;
      changed = true;
    }
    if (!(await verifyPassword(existing.passwordHash, options.password))) {
      existing.passwordHash = await hashPassword(options.password);
      existing.authVersion += 1;
      changed = true;
    }
    if (changed) {
      await existing.save();
      summary.updated.push(emailLower);
    } else {
      summary.unchanged.push(emailLower);
    }
  }
  summary.profilesCreated = await seedDemoProfiles(conn, options.accounts ?? DEMO_ACCOUNTS);
  summary.briefsCreated = await seedDemoBriefs(conn);
  return summary;
}

/**
 * Creates the fixture profiles for demo accounts that have none yet (revision 1). Existing
 * profiles are left alone so demo edits survive a re-run; `--reset` recreates them. Consent is
 * written before a profile is made discoverable, matching ProfileService.
 */
async function seedDemoProfiles(
  conn: Connection,
  accounts: readonly DemoAccount[],
): Promise<number> {
  const { User } = identityModels(conn);
  const { CandidateProfile, FounderProfile, ConsentRecord } = profileModels(conn);
  let created = 0;
  const now = new Date();
  for (const account of accounts) {
    const user = await User.findOne({ seedKey: account.seedKey }, { _id: 1 }).lean().exec();
    if (!user) continue;
    const candidate = DEMO_CANDIDATE_PROFILES[account.seedKey];
    if (candidate && !(await CandidateProfile.exists({ userId: user._id }))) {
      if (candidate.discoverable) {
        const id = user._id.toHexString();
        await ConsentRecord.updateOne(
          { activeKey: consentActiveKey(id, 'profile_discovery', id) },
          {
            $setOnInsert: {
              userId: user._id,
              purpose: 'profile_discovery',
              targetId: user._id,
              policyVersion: PROFILE_DISCLOSURE_POLICY_VERSION,
              grantedAt: now,
              withdrawnAt: null,
            },
          },
          { upsert: true },
        ).exec();
      }
      await CandidateProfile.create({
        userId: user._id,
        revision: 1,
        headline: candidate.headline,
        bio: candidate.bio,
        skills: candidate.skills,
        industryTags: candidate.industryTags,
        missionTags: candidate.missionTags,
        availableHoursPerWeek: candidate.availableHoursPerWeek,
        commitmentMonths: candidate.commitmentMonths,
        opportunityTypes: ['contributor'],
        projects: candidate.projects.map((p) => ({
          _id: new mongoose.Types.ObjectId(),
          ...p,
          evidenceStatus: p.url ? 'project_linked' : 'self_reported',
        })),
        discoveryEnabled: candidate.discoverable,
      });
      created += 1;
    }
    const founder = DEMO_FOUNDER_PROFILES[account.seedKey];
    if (founder && !(await FounderProfile.exists({ userId: user._id }))) {
      await FounderProfile.create({ userId: user._id, revision: 1, ...founder });
      created += 1;
    }
  }
  return created;
}

/**
 * Creates the Section 26 briefs that do not exist yet (by seedKey) as published version 1.
 * Existing briefs are never modified: published briefs are immutable.
 */
async function seedDemoBriefs(conn: Connection): Promise<number> {
  const { User } = identityModels(conn);
  const { StartupBrief } = briefModels(conn);
  let created = 0;
  for (const brief of DEMO_BRIEFS) {
    if (await StartupBrief.exists({ seedKey: brief.seedKey })) continue;
    const founder = await User.findOne({ seedKey: brief.founderSeedKey }, { _id: 1 }).lean().exec();
    if (!founder) continue;
    if (briefPublishGaps(brief.fields).length > 0 || !hasSkillGap(brief.fields)) {
      throw new Error(`Demo brief ${brief.seedKey} does not pass the publish validator.`);
    }
    await StartupBrief.create({
      seedKey: brief.seedKey,
      founderUserId: founder._id,
      status: 'open',
      version: 1,
      transitionRevision: 1,
      ...BRIEF_CONSTANTS,
      ...brief.fields,
      publishedAt: new Date(),
      closedAt: null,
      closeReason: null,
    });
    created += 1;
  }
  return created;
}
