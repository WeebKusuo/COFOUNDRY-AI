import mongoose from 'mongoose';
import {
  PROFILE_DISCLOSURE_POLICY_VERSION,
  discoveryGaps,
  type CandidateProfileData,
  type FounderProfileData,
  type MeData,
  type ProfilePublic,
  type SkillId,
} from '@cofoundry/shared';
import { AppError } from '../http/errors.js';
import type { IdentityStore, UserRecord } from '../auth/store.js';
import type {
  CandidateProfileFields,
  CandidateProfileRecord,
  ConsentKey,
  FounderProfileFields,
  FounderProfileRecord,
  ProfileStore,
} from './store.js';

/** Validated PUT /candidate/profile input (output of the route's Zod schema). */
export interface CandidateProfileInput extends Omit<CandidateProfileFields, 'projects'> {
  expectedRevision: number;
  discoveryConsent: boolean;
  projects: Array<{
    id?: string | undefined;
    title: string;
    description: string;
    skillTags: SkillId[];
    url: string | null;
  }>;
}

export interface FounderProfileInput extends FounderProfileFields {
  expectedRevision: number;
}

const conflict = () =>
  new AppError(
    'VERSION_CONFLICT',
    'Your profile changed since you opened it. Reload to see the latest version.',
  );

const notFound = () => new AppError('NOT_FOUND', 'The requested resource was not found.');

function discoveryKey(userId: string): ConsentKey {
  // The consent covers disclosing this user's own profile, so the user is the target.
  return { userId, purpose: 'profile_discovery', targetId: userId };
}

/**
 * Profile rules (Sections 03, 06, 14, 18).
 *
 * Profile and consent live in separate collections and are written in an order that keeps the
 * privacy invariant "discoverable ⇒ active disclosure consent" true after every single write:
 * consent is granted before a profile is made discoverable, and withdrawn only after the profile
 * write (which the validator forces to discovery off) has succeeded. A failure between the two
 * writes therefore never exposes a profile without consent, and repeating the request completes
 * it. No multi-document transaction is needed for this; transactions are used where two users'
 * records change together (later phases).
 */
export class ProfileService {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly identity: IdentityStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async toCandidateData(
    userId: string,
    record: CandidateProfileRecord | null,
  ): Promise<CandidateProfileData> {
    const consent = await this.profiles.hasActiveConsent(discoveryKey(userId));
    if (!record) {
      return {
        userId,
        revision: 0,
        headline: '',
        bio: '',
        skills: [],
        industryTags: [],
        missionTags: [],
        availableHoursPerWeek: null,
        commitmentMonths: null,
        opportunityTypes: [],
        projects: [],
        discoveryEnabled: false,
        discoveryConsent: consent,
        updatedAt: null,
      };
    }
    return {
      userId,
      revision: record.revision,
      headline: record.headline,
      bio: record.bio,
      skills: record.skills,
      industryTags: record.industryTags,
      missionTags: record.missionTags,
      availableHoursPerWeek: record.availableHoursPerWeek,
      commitmentMonths: record.commitmentMonths,
      opportunityTypes: record.opportunityTypes,
      projects: record.projects,
      // Defence in depth: never report discoverable without an active consent record.
      discoveryEnabled: record.discoveryEnabled && consent,
      discoveryConsent: consent,
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  async getCandidate(user: UserRecord): Promise<CandidateProfileData> {
    return this.toCandidateData(user.id, await this.profiles.findCandidate(user.id));
  }

  async updateCandidate(
    user: UserRecord,
    input: CandidateProfileInput,
  ): Promise<CandidateProfileData> {
    const current = await this.profiles.findCandidate(user.id);
    if ((current?.revision ?? 0) !== input.expectedRevision) throw conflict();

    // Project ids are server-generated; a supplied id must name one of this profile's projects.
    const existingIds = new Set(current?.projects.map((p) => p.id) ?? []);
    const fieldErrors: Record<string, string[]> = {};
    const projects = input.projects.map((p, i) => {
      if (p.id !== undefined && !existingIds.has(p.id)) {
        fieldErrors[`body.projects.${i}.id`] = ['Unknown project.'];
      }
      return {
        id: p.id ?? new mongoose.Types.ObjectId().toHexString(),
        title: p.title,
        description: p.description,
        skillTags: p.skillTags,
        url: p.url,
        // Derived: a syntactically valid HTTPS link — never means fetched or verified.
        evidenceStatus: p.url ? ('project_linked' as const) : ('self_reported' as const),
      };
    });
    if (Object.keys(fieldErrors).length > 0) {
      throw new AppError('VALIDATION_FAILED', 'Some fields are invalid.', { fieldErrors });
    }

    const fields: CandidateProfileFields = {
      headline: input.headline,
      bio: input.bio,
      skills: input.skills,
      industryTags: input.industryTags,
      missionTags: input.missionTags,
      availableHoursPerWeek: input.availableHoursPerWeek,
      commitmentMonths: input.commitmentMonths,
      opportunityTypes: input.opportunityTypes,
      projects,
      discoveryEnabled: input.discoveryEnabled,
    };

    const key = discoveryKey(user.id);
    const at = this.now();
    // Order matters — see the class comment.
    if (input.discoveryConsent && input.discoveryEnabled) {
      await this.profiles.grantConsent(key, PROFILE_DISCLOSURE_POLICY_VERSION, at);
    }
    const saved = await this.profiles.saveCandidate(user.id, input.expectedRevision, fields);
    if (saved === 'conflict') throw conflict();
    if (input.discoveryConsent && !input.discoveryEnabled) {
      await this.profiles.grantConsent(key, PROFILE_DISCLOSURE_POLICY_VERSION, at);
    }
    if (!input.discoveryConsent) {
      await this.profiles.withdrawConsent(key, at);
    }
    return this.toCandidateData(user.id, saved);
  }

  private toFounderData(userId: string, record: FounderProfileRecord | null): FounderProfileData {
    return record
      ? {
          userId,
          revision: record.revision,
          bio: record.bio,
          companyUrl: record.companyUrl,
          updatedAt: record.updatedAt.toISOString(),
        }
      : { userId, revision: 0, bio: '', companyUrl: null, updatedAt: null };
  }

  async getFounder(user: UserRecord): Promise<FounderProfileData> {
    return this.toFounderData(user.id, await this.profiles.findFounder(user.id));
  }

  async updateFounder(user: UserRecord, input: FounderProfileInput): Promise<FounderProfileData> {
    const saved = await this.profiles.saveFounder(user.id, input.expectedRevision, {
      bio: input.bio,
      companyUrl: input.companyUrl,
    });
    if (saved === 'conflict') throw conflict();
    return this.toFounderData(user.id, saved);
  }

  /**
   * GET /profiles/:userId (Section 18). Visible only when:
   *  - it is the viewer's own profile, or
   *  - the target is an active candidate in the viewer's cohort whose profile is discoverable with
   *    an active disclosure consent.
   * Everything else — unknown, private, suspended, other-cohort or founder profiles — is 404, so
   * existence is never confirmed. Blocks and established-participant access arrive with the
   * features that create those relationships.
   */
  async getPublic(viewer: UserRecord, targetUserId: string): Promise<ProfilePublic> {
    const target =
      targetUserId === viewer.id ? viewer : await this.identity.findUserById(targetUserId);
    if (!target || target.status !== 'active') throw notFound();
    const self = target.id === viewer.id;
    if (!self && target.cohortId !== viewer.cohortId) throw notFound();

    let candidate: ProfilePublic['candidate'] = null;
    if (target.roles.includes('candidate')) {
      const record = await this.profiles.findCandidate(target.id);
      const discoverable =
        record !== null &&
        record.discoveryEnabled &&
        (await this.profiles.hasActiveConsent(discoveryKey(target.id)));
      if (record && (self || discoverable)) {
        candidate = {
          headline: record.headline,
          bio: record.bio,
          skills: record.skills,
          industryTags: record.industryTags,
          missionTags: record.missionTags,
          availableHoursPerWeek: record.availableHoursPerWeek,
          commitmentMonths: record.commitmentMonths,
          projects: record.projects,
        };
      }
    }

    let founder: ProfilePublic['founder'] = null;
    if (self && target.roles.includes('founder')) {
      const record = await this.profiles.findFounder(target.id);
      if (record) founder = { bio: record.bio, companyUrl: record.companyUrl };
    }

    if (!self && !candidate) throw notFound();
    return {
      userId: target.id,
      displayName: target.displayName,
      demoAccount: target.accountMode === 'demo',
      candidate,
      founder,
    };
  }

  /** GET /me profile summaries: one entry per held role that has a saved profile. */
  async summaries(user: UserRecord): Promise<MeData['profileSummaries']> {
    const out: MeData['profileSummaries'] = [];
    if (user.roles.includes('founder')) {
      const founder = await this.profiles.findFounder(user.id);
      if (founder) out.push({ role: 'founder', revision: founder.revision, complete: true });
    }
    if (user.roles.includes('candidate')) {
      const record = await this.profiles.findCandidate(user.id);
      if (record) {
        const gaps = discoveryGaps({ ...record, discoveryConsent: true });
        out.push({ role: 'candidate', revision: record.revision, complete: gaps.length === 0 });
      }
    }
    return out;
  }
}
