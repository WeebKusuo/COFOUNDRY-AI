import {
  NO_SKILL_GAP_MESSAGE,
  TRIAL_CAP_HOURS,
  briefPublishGaps,
  compensationDraftFromTerms,
  hasSkillGap,
  toCompensationTerms,
  type BriefDraftFields,
  type BriefOwnerSummary,
  type BriefPreview,
  type BriefView,
  type StartupBriefData,
} from '@cofoundry/shared';
import { AppError } from '../http/errors.js';
import type { IdentityStore, UserRecord } from '../auth/store.js';
import type { ProfileStore } from '../profiles/store.js';
import { BRIEF_CONSTANTS, type BriefRecord, type BriefStore, type PagePosition } from './store.js';

export interface Page<T> {
  items: T[];
  next: PagePosition | null;
}

const notFound = () => new AppError('NOT_FOUND', 'The requested resource was not found.');
const versionConflict = () =>
  new AppError(
    'VERSION_CONFLICT',
    'This brief changed since you opened it. Reload to see the latest version.',
  );
const notDraft = () =>
  new AppError(
    'INVALID_STATE',
    'Published briefs cannot be edited. Clone it to create a new draft with different terms.',
  );

/** Content fields copied by clone (everything a founder wrote; no status, dates or versions). */
function contentOf(r: BriefRecord): BriefDraftFields {
  return {
    title: r.title,
    teaser: r.teaser,
    problem: r.problem,
    solution: r.solution,
    industryTags: [...r.industryTags],
    missionTags: [...r.missionTags],
    teamSkills: r.teamSkills.map((s) => ({ ...s })),
    requiredSkills: r.requiredSkills.map((s) => ({ ...s })),
    hoursRequiredPerWeek: r.hoursRequiredPerWeek,
    commitmentMonths: r.commitmentMonths,
    mandatoryAvailability: r.mandatoryAvailability,
    mandatoryCommitment: r.mandatoryCommitment,
    compensation: { ...r.compensation },
  };
}

export function toBriefData(r: BriefRecord): StartupBriefData {
  return {
    id: r.id,
    status: r.status,
    version: r.version,
    ...BRIEF_CONSTANTS,
    ...contentOf(r),
    publishedAt: r.publishedAt?.toISOString() ?? null,
    closedAt: r.closedAt?.toISOString() ?? null,
    closeReason: r.closeReason,
    clonedFromId: r.clonedFromId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toSummary(r: BriefRecord): BriefOwnerSummary {
  return {
    id: r.id,
    status: r.status,
    version: r.version,
    title: r.title,
    teaser: r.teaser,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    closedAt: r.closedAt?.toISOString() ?? null,
    clonedFromId: r.clonedFromId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function nextPosition(records: BriefRecord[], limit: number): PagePosition | null {
  if (records.length <= limit) return null;
  const last = records[limit - 1]!;
  return { createdAt: last.createdAt, id: last.id };
}

/**
 * Brief lifecycle (Sections 03, 06, 14, 18): draft -> open -> closed, owner-only edits on drafts,
 * immutable published version 1, explicit clone for new terms. Visibility:
 *  - the founder who owns a brief sees everything, in every state;
 *  - an active candidate in the founder's cohort sees the teaser projection of an OPEN brief;
 *  - everyone else gets 404, so the existence of drafts and other cohorts' briefs is never
 *    confirmed. Problem and solution are never part of the teaser; the full-brief access grant
 *    (POST /startups/:id/access) arrives with the interview-invitation phase.
 *
 * Closing currently has no dependent records to cancel; when interviews and requests exist, the
 * close effects of Section 06 run in the same transaction as this status change.
 */
export class BriefService {
  constructor(
    private readonly briefs: BriefStore,
    private readonly identity: IdentityStore,
    private readonly profiles: ProfileStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Phase 13: completed-trial counts come from sprint records (wired after construction). */
  private completedTrials: (founderUserId: string) => Promise<number> = async () => 0;

  attachCompletedTrials(count: (founderUserId: string) => Promise<number>): void {
    this.completedTrials = count;
  }

  private async owned(user: UserRecord, id: string): Promise<BriefRecord> {
    const record = await this.briefs.findById(id);
    if (!record || record.founderUserId !== user.id) throw notFound();
    return record;
  }

  async create(user: UserRecord, id: string, fields: BriefDraftFields): Promise<StartupBriefData> {
    const { record } = await this.briefs.insertDraft({
      id,
      founderUserId: user.id,
      fields,
      clonedFromId: null,
    });
    // An idempotent retry may find the record already created; it must still be ours.
    if (record.founderUserId !== user.id) throw notFound();
    return toBriefData(record);
  }

  async clone(user: UserRecord, sourceId: string, newId: string): Promise<StartupBriefData> {
    const source = await this.owned(user, sourceId);
    const { record } = await this.briefs.insertDraft({
      id: newId,
      founderUserId: user.id,
      fields: contentOf(source),
      clonedFromId: source.id,
    });
    if (record.founderUserId !== user.id) throw notFound();
    return toBriefData(record);
  }

  async getOwned(user: UserRecord, id: string): Promise<StartupBriefData> {
    return toBriefData(await this.owned(user, id));
  }

  async listMine(
    user: UserRecord,
    page: { after: PagePosition | null; limit: number },
  ): Promise<Page<BriefOwnerSummary>> {
    const records = await this.briefs.listByFounder(user.id, page);
    return {
      items: records.slice(0, page.limit).map(toSummary),
      next: nextPosition(records, page.limit),
    };
  }

  /** Teaser previews of open briefs from active founders in the candidate's cohort. */
  async discover(
    user: UserRecord,
    page: { after: PagePosition | null; limit: number },
  ): Promise<Page<BriefPreview>> {
    const founders = (
      await this.identity.listActiveUserIdsInCohort(user.cohortId, 'founder')
    ).filter(
      (id) => id !== user.id, // self-pairing is prohibited (Section 01)
    );
    const records = await this.briefs.listOpenByFounders(founders, page);
    const items: BriefPreview[] = [];
    for (const record of records.slice(0, page.limit)) {
      const founder = await this.identity.findUserById(record.founderUserId);
      if (founder) items.push(await this.preview(record, founder));
    }
    return { items, next: nextPosition(records, page.limit) };
  }

  async get(user: UserRecord, id: string): Promise<BriefView> {
    const record = await this.briefs.findById(id);
    if (!record) throw notFound();
    if (record.founderUserId === user.id) {
      return {
        access: 'owner',
        brief: toBriefData(record),
        preview: await this.preview(record, user),
      };
    }
    if (!user.roles.includes('candidate') || record.status !== 'open') throw notFound();
    const founder = await this.identity.findUserById(record.founderUserId);
    if (
      !founder ||
      founder.status !== 'active' ||
      !founder.roles.includes('founder') ||
      founder.cohortId !== user.cohortId
    ) {
      throw notFound();
    }
    return { access: 'preview', preview: await this.preview(record, founder) };
  }

  async patch(
    user: UserRecord,
    id: string,
    expectedVersion: number,
    changes: Partial<BriefDraftFields>,
  ): Promise<StartupBriefData> {
    const updated = await this.briefs.updateDraft(id, user.id, expectedVersion, changes);
    if (updated) return toBriefData(updated);
    const current = await this.owned(user, id);
    if (current.status !== 'draft') throw notDraft();
    throw versionConflict();
  }

  async publish(user: UserRecord, id: string, expectedVersion: number): Promise<StartupBriefData> {
    const current = await this.owned(user, id);
    // Repeating a successful transition returns the existing resource (Section 25).
    if (current.status === 'open') return toBriefData(current);
    if (current.status === 'closed') {
      throw new AppError(
        'INVALID_STATE',
        'A closed brief cannot be published again. Clone it instead.',
      );
    }
    if (current.version !== expectedVersion) throw versionConflict();

    const gaps = briefPublishGaps(current);
    if (gaps.length > 0) {
      const fieldErrors: Record<string, string[]> = {};
      for (const gap of gaps) (fieldErrors[`brief.${gap.field}`] ??= []).push(gap.message);
      throw new AppError(
        'VALIDATION_FAILED',
        'Complete the highlighted fields before publishing.',
        {
          fieldErrors,
        },
      );
    }
    if (!hasSkillGap(current)) {
      throw new AppError('NO_SKILL_GAP', NO_SKILL_GAP_MESSAGE, {
        fieldErrors: { 'brief.requiredSkills': [NO_SKILL_GAP_MESSAGE] },
      });
    }
    const terms = toCompensationTerms(current.compensation)!;
    const published = await this.briefs.publish(
      id,
      user.id,
      expectedVersion,
      { compensation: compensationDraftFromTerms(terms) },
      this.now(),
    );
    if (published) return toBriefData(published);
    // Lost a race: re-read and answer as if we had arrived second.
    const after = await this.owned(user, id);
    if (after.status === 'open') return toBriefData(after);
    if (after.status === 'closed') throw new AppError('INVALID_STATE', 'This brief is closed.');
    throw versionConflict();
  }

  async close(user: UserRecord, id: string, reason: string): Promise<StartupBriefData> {
    const current = await this.owned(user, id);
    if (current.status === 'closed') return toBriefData(current);
    if (current.status === 'draft') {
      throw new AppError('INVALID_STATE', 'Only published briefs can be closed.');
    }
    const closed = await this.briefs.close(id, user.id, reason, this.now());
    if (closed) return toBriefData(closed);
    const after = await this.owned(user, id);
    if (after.status === 'closed') return toBriefData(after);
    throw new AppError('INVALID_STATE', 'This brief cannot be closed.');
  }

  /** Section 06 teaser projection. */
  async preview(record: BriefRecord, founder: UserRecord): Promise<BriefPreview> {
    const founderProfile = await this.profiles.findFounder(founder.id);
    return {
      id: record.id,
      status: record.status,
      version: record.version,
      title: record.title,
      teaser: record.teaser,
      roleKey: BRIEF_CONSTANTS.roleKey,
      opportunityType: BRIEF_CONSTANTS.opportunityType,
      workMode: BRIEF_CONSTANTS.workMode,
      requiredSkills: record.requiredSkills.map((s) => ({ ...s })),
      hoursRequiredPerWeek: record.hoursRequiredPerWeek,
      commitmentMonths: record.commitmentMonths,
      compensation: toCompensationTerms(record.compensation),
      ipPolicyVersion: BRIEF_CONSTANTS.ipPolicyVersion,
      trialCapHours: TRIAL_CAP_HOURS,
      founder: {
        displayName: founder.displayName,
        demoAccount: founder.accountMode === 'demo',
        companyUrl: founderProfile?.companyUrl ?? null,
        // "Completed trials": completed sprint records irrespective of outcome (Section 13).
        completedSprintCount: await this.completedTrials(founder.id),
      },
      publishedAt: record.publishedAt?.toISOString() ?? null,
    };
  }
}
