import {
  DISCOVERY_POOL_MAX,
  MATCH_ALGORITHM_VERSION,
  RECOMMENDATION_ENTRY_RETENTION_MS,
  RECOMMENDATION_TTL_MS,
  type RecommendationEntry,
  type RecommendationEntryView,
  type RecommendationProfile,
  type RecommendationSearchResponse,
} from '@cofoundry/shared';
import type { IdentityStore, UserRecord } from '../auth/store.js';
import type { BriefRecord, BriefStore } from '../briefs/store.js';
import { AppError } from '../http/errors.js';
import {
  MatchBriefError,
  evaluateCandidate,
  matchCandidates,
  prepareBrief,
  type MatchBrief,
  type MatchCandidate,
} from '../matching/engine.js';
import type { CandidateProfileRecord, ProfileStore } from '../profiles/store.js';
import { NO_BLOCKS_YET, type BlockPolicy } from '../safety/blocks.js';
import type { RecommendationBatchRecord, RecommendationStore } from './store.js';

const notFound = () => new AppError('NOT_FOUND', 'The requested resource was not found.');
const stale = (message = 'These results are out of date. Run a new search.') =>
  new AppError('STALE_RECOMMENDATION', message);

interface VisibleCandidate {
  user: UserRecord;
  profile: CandidateProfileRecord;
}

function toMatchBrief(b: BriefRecord): MatchBrief {
  return {
    requiredSkills: b.requiredSkills,
    teamSkills: b.teamSkills,
    hoursRequiredPerWeek: b.hoursRequiredPerWeek ?? 0,
    commitmentMonths: b.commitmentMonths ?? 0,
    mandatoryAvailability: b.mandatoryAvailability,
    mandatoryCommitment: b.mandatoryCommitment,
    industryTags: b.industryTags,
    missionTags: b.missionTags,
  };
}

function toMatchCandidate(v: VisibleCandidate): MatchCandidate | null {
  const p = v.profile;
  // A discoverable profile always has these (Section 03); anything else is not matchable.
  if (p.availableHoursPerWeek === null || p.commitmentMonths === null) return null;
  return {
    userId: v.user.id,
    profileRevision: p.revision,
    skills: p.skills,
    availableHoursPerWeek: p.availableHoursPerWeek,
    commitmentMonths: p.commitmentMonths,
    opportunityTypes: p.opportunityTypes,
    industryTags: p.industryTags,
    missionTags: p.missionTags,
    projects: p.projects.map((pr) => ({ id: pr.id, title: pr.title, skillTags: pr.skillTags })),
  };
}

/** ProfilePublic candidate fields only (Section 17): no email, consent, account or resume data. */
function toProfile(v: VisibleCandidate): RecommendationProfile {
  const p = v.profile;
  return {
    displayName: v.user.displayName,
    demoAccount: v.user.accountMode === 'demo',
    headline: p.headline,
    bio: p.bio,
    skills: p.skills,
    industryTags: p.industryTags,
    missionTags: p.missionTags,
    availableHoursPerWeek: p.availableHoursPerWeek,
    commitmentMonths: p.commitmentMonths,
    projects: p.projects,
  };
}

/**
 * Recommendation batches (Sections 04-06, 15, 19, 25).
 *
 *  - Searches run on the founder's own OPEN brief, over active, discoverable, consenting
 *    candidates of the founder's cohort (never the founder, never blocked), loaded with three
 *    bulk queries. The pure engine scores them; the batch stores only computed results and each
 *    candidate's profileRevision, and expires after 15 minutes.
 *  - Every read re-checks visibility first and silently withholds candidates who became hidden,
 *    inactive, blocked or non-consenting (without refilling or revealing them). If any remaining
 *    candidate's profile revision changed, or the batch expired, or the brief is no longer the
 *    open version searched, the batch is stale: 409 STALE_RECOMMENDATION. Withheld candidates
 *    are not counted or marked in the response.
 */
export class RecommendationService {
  constructor(
    private readonly batches: RecommendationStore,
    private readonly briefs: BriefStore,
    private readonly identity: IdentityStore,
    private readonly profiles: ProfileStore,
    private readonly blocks: BlockPolicy = NO_BLOCKS_YET,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async ownedBrief(founder: UserRecord, briefId: string): Promise<BriefRecord> {
    const brief = await this.briefs.findById(briefId);
    if (!brief || brief.founderUserId !== founder.id) throw notFound();
    return brief;
  }

  /**
   * Visible candidates among `userIds` (or the founder's whole cohort when omitted), in three
   * bulk queries. Visibility = active candidate in the founder's cohort, not the founder, not
   * blocked, discovery on and an active profile-discovery consent.
   */
  private async visibleCandidates(
    founder: UserRecord,
    userIds?: readonly string[],
  ): Promise<Map<string, VisibleCandidate>> {
    let users: UserRecord[];
    if (userIds) {
      users = (await this.identity.findUsersByIds(userIds)).filter(
        (u) =>
          u.status === 'active' &&
          u.roles.includes('candidate') &&
          u.cohortId === founder.cohortId &&
          u.id !== founder.id,
      );
    } else {
      const ids = (
        await this.identity.listActiveUserIdsInCohort(founder.cohortId, 'candidate')
      ).filter((id) => id !== founder.id);
      users = await this.identity.findUsersByIds(ids);
    }
    const blocked = await this.blocks.blockedAmong(
      founder.id,
      users.map((u) => u.id),
    );
    users = users.filter((u) => !blocked.has(u.id));
    // Discoverable = discovery on AND an active consent: consent first, so the capacity check
    // below counts only discoverable people (never those who did not consent).
    const consenting = await this.profiles.activeSelfConsentUserIds(
      'profile_discovery',
      users.map((u) => u.id),
    );
    const profiles = await this.profiles.findCandidates(
      users.map((u) => u.id).filter((id) => consenting.has(id)),
      { discoverableOnly: true, ...(userIds ? {} : { limit: DISCOVERY_POOL_MAX + 1 }) },
    );
    if (!userIds && profiles.length > DISCOVERY_POOL_MAX) {
      // Section 23: reject an oversized cohort rather than silently sampling it.
      throw new AppError('CAPACITY_LIMIT', 'This cohort is too large to search in this version.');
    }
    const byId = new Map(users.map((u) => [u.id, u]));
    const out = new Map<string, VisibleCandidate>();
    for (const profile of profiles) {
      const user = byId.get(profile.userId);
      if (user && consenting.has(profile.userId)) out.set(user.id, { user, profile });
    }
    return out;
  }

  /** POST /startups/:id/recommendations: compute and persist a new batch for `batchId`. */
  async generate(
    founder: UserRecord,
    briefId: string,
    batchId: string,
  ): Promise<RecommendationSearchResponse> {
    const brief = await this.ownedBrief(founder, briefId);
    if (brief.status !== 'open') {
      throw new AppError('INVALID_STATE', 'Only open briefs can be searched. Publish it first.');
    }
    const visible = await this.visibleCandidates(founder);
    const pool = [...visible.values()]
      .map(toMatchCandidate)
      .filter((c): c is MatchCandidate => c !== null);

    let result;
    try {
      result = matchCandidates(toMatchBrief(brief), pool);
    } catch (err) {
      if (err instanceof MatchBriefError) {
        throw err.problem === 'no_skill_gap'
          ? new AppError('NO_SKILL_GAP', 'This brief has no skill gap to match against.')
          : new AppError('VALIDATION_FAILED', 'This brief cannot be matched.', {
              fieldErrors: { brief: [err.problem] },
            });
      }
      throw err;
    }
    const at = this.now();
    const record = await this.batches.insert({
      id: batchId,
      briefId: brief.id,
      briefVersion: brief.version,
      founderUserId: founder.id,
      algorithmVersion: MATCH_ALGORITHM_VERSION,
      generatedAt: at,
      expiresAt: new Date(at.getTime() + RECOMMENDATION_TTL_MS),
      totalExcluded: result.exclusions.totalExcluded,
      gateCounts: result.exclusions.gates,
      entries: [...result.recommendations, ...result.provisional, ...result.nearMatches],
      entriesPurgedAt: null,
    });
    // An idempotent retry may have found an existing batch: read it like any stored batch.
    if (record.generatedAt.getTime() !== at.getTime()) return this.read(founder, record);
    return this.view(record, visible);
  }

  /** GET /startups/:id/recommendations: the latest batch, if still valid. */
  async latest(founder: UserRecord, briefId: string): Promise<RecommendationSearchResponse> {
    await this.ownedBrief(founder, briefId);
    const batch = await this.batches.findLatestForBrief(briefId);
    if (!batch || batch.founderUserId !== founder.id) {
      throw stale('No current results for this brief. Run a search.');
    }
    return this.read(founder, batch);
  }

  /** A specific batch (idempotent replay of a search). */
  async byId(founder: UserRecord, briefId: string, batchId: string) {
    await this.ownedBrief(founder, briefId);
    const batch = await this.batches.findById(batchId);
    if (!batch || batch.founderUserId !== founder.id || batch.briefId !== briefId) throw notFound();
    return this.read(founder, batch);
  }

  /** Validity checks that make a stored batch unusable as a whole. */
  private async assertUsable(batch: RecommendationBatchRecord): Promise<void> {
    if (batch.expiresAt.getTime() <= this.now().getTime() || batch.entriesPurgedAt) {
      throw stale('These results expired after 15 minutes. Run a new search.');
    }
    const brief = await this.briefs.findById(batch.briefId);
    if (!brief || brief.status !== 'open' || brief.version !== batch.briefVersion) {
      throw stale('The brief changed or closed since this search.');
    }
  }

  private async read(
    founder: UserRecord,
    batch: RecommendationBatchRecord,
  ): Promise<RecommendationSearchResponse> {
    await this.assertUsable(batch);
    const ids = batch.entries.map((e) => e.candidateUserId);
    // Privacy first (Section 06): silently drop entries whose candidate is no longer visible —
    // no count or marker, so a founder cannot learn that someone hid, left or blocked them...
    const visible = await this.visibleCandidates(founder, ids);
    const kept = batch.entries.filter((e) => visible.has(e.candidateUserId));
    // ...then any revision change among the remaining entries invalidates the batch.
    if (kept.some((e) => visible.get(e.candidateUserId)!.profile.revision !== e.profileRevision)) {
      throw stale('A candidate updated their profile since this search. Run a new search.');
    }
    return this.view({ ...batch, entries: kept }, visible);
  }

  private view(
    batch: RecommendationBatchRecord,
    visible: Map<string, VisibleCandidate>,
  ): RecommendationSearchResponse {
    const entries: RecommendationEntryView[] = batch.entries.flatMap((e) => {
      const v = visible.get(e.candidateUserId);
      return v ? [{ ...e, profile: toProfile(v) }] : [];
    });
    const group = (g: RecommendationEntry['group']) => entries.filter((e) => e.group === g);
    return {
      batchId: batch.id,
      briefId: batch.briefId,
      briefVersion: batch.briefVersion,
      generatedAt: batch.generatedAt.toISOString(),
      expiresAt: batch.expiresAt.toISOString(),
      algorithmVersion: batch.algorithmVersion,
      recommendations: group('recommendations'),
      provisional: group('provisional'),
      nearMatches: group('nearMatches'),
      exclusions: { totalExcluded: batch.totalExcluded, gates: batch.gateCounts },
    };
  }

  /**
   * Invitation boundary (used by the interview phase, MAT-08): an invitation may only be created
   * from an unexpired batch of the founder's open brief, for a listed, still-visible candidate
   * whose profile revision is unchanged and who still passes every hard gate. Anything else is
   * 409 STALE_RECOMMENDATION.
   */
  async resolveForInvitation(
    founder: UserRecord,
    input: { briefId: string; batchId: string; candidateUserId: string },
  ): Promise<{ entry: RecommendationEntry; profileRevision: number; briefVersion: number }> {
    await this.ownedBrief(founder, input.briefId);
    const batch = await this.batches.findById(input.batchId);
    if (!batch || batch.founderUserId !== founder.id || batch.briefId !== input.briefId) {
      throw stale();
    }
    await this.assertUsable(batch);
    const entry = batch.entries.find((e) => e.candidateUserId === input.candidateUserId);
    if (!entry) throw stale('This candidate is not in the current results.');
    const visible = await this.visibleCandidates(founder, [input.candidateUserId]);
    const current = visible.get(input.candidateUserId);
    if (!current || current.profile.revision !== entry.profileRevision) throw stale();
    const brief = (await this.briefs.findById(input.briefId))!;
    const candidate = toMatchCandidate(current);
    if (!candidate || !evaluateCandidate(prepareBrief(toMatchBrief(brief)), candidate).passed) {
      throw stale('This candidate no longer meets the brief’s requirements.');
    }
    return { entry, profileRevision: entry.profileRevision, briefVersion: batch.briefVersion };
  }

  /** Retention job (Section 24): personal entry contents are removed after 24 hours. */
  async purgeExpiredEntries(): Promise<number> {
    const at = this.now();
    return this.batches.purgeEntriesBefore(
      new Date(at.getTime() - RECOMMENDATION_ENTRY_RETENTION_MS),
      at,
    );
  }
}
