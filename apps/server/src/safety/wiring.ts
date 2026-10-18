import { AuditLog, type AuditStore } from '../audit/audit.js';
import type { IdentityStore } from '../auth/store.js';
import type { BriefService } from '../briefs/service.js';
import type { BriefStore } from '../briefs/store.js';
import { CollaborationService } from '../collaboration/requests.js';
import { SprintService } from '../collaboration/sprints.js';
import type { MatchRequestStore, MatchStore, SprintStore } from '../collaboration/store.js';
import type { TransactionRunner } from '../db/transactions.js';
import type { InterviewService } from '../interviews/service.js';
import type { Logger } from '../lib/logger.js';
import type { ProfileService } from '../profiles/service.js';
import type { ProfileStore } from '../profiles/store.js';
import type { RecommendationService } from '../recommendations/service.js';
import { SafetyService } from './service.js';
import type { BlockStore, RelationshipGuardStore, SafetyCaseStore } from './store.js';

/**
 * Builds the Phase 11-14 services and connects them to the earlier phases: interview facts and
 * safety hooks, the brief preview's completed-trials count. Used by the server, the E2E server
 * and the test harness so all three wire the same graph.
 */
export interface Phase11To14Stores {
  requests: MatchRequestStore;
  matches: MatchStore;
  sprints: SprintStore;
  blocks: BlockStore;
  guards: RelationshipGuardStore;
  cases: SafetyCaseStore;
  audit: AuditStore;
  tx: TransactionRunner;
}

export function buildCollaborationAndSafety(
  stores: Phase11To14Stores,
  deps: {
    identity: IdentityStore;
    briefStore: BriefStore;
    briefs: BriefService;
    profiles: ProfileStore;
    /** When given, current public profiles are hidden across a block. */
    profileService?: ProfileService;
    interviews: InterviewService;
    recommendations: RecommendationService;
    logger?: Logger;
    now?: () => Date;
  },
) {
  const now = deps.now;
  const audit = new AuditLog(stores.audit, now);
  const shared = {
    requests: stores.requests,
    matches: stores.matches,
    sprints: stores.sprints,
    blocks: stores.blocks,
    guards: stores.guards,
    tx: stores.tx,
    identity: deps.identity,
    briefStore: deps.briefStore,
    profiles: deps.profiles,
    interviews: deps.interviews,
    audit,
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(now ? { now } : {}),
  };
  const collaboration = new CollaborationService(shared);
  const sprints = new SprintService(shared);
  const safety = new SafetyService({
    blocks: stores.blocks,
    guards: stores.guards,
    cases: stores.cases,
    tx: stores.tx,
    identity: deps.identity,
    briefStore: deps.briefStore,
    profiles: deps.profiles,
    sprints: stores.sprints,
    collaboration,
    interviews: deps.interviews,
    recentlyRecommended: (f, c) => deps.recommendations.recentlyRecommended(f, c),
    audit,
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(now ? { now } : {}),
  });
  collaboration.attachReportSafety(safety);
  deps.interviews.attachSafety({
    isBlocked: (a, b) => stores.blocks.existsEither(a, b),
    reportOverlays: (id) => safety.reportOverlays(id),
    heldSessionIds: () => safety.heldSessionIds(),
    auditReportRead: (actorId, interviewId) =>
      audit.record({
        actorId,
        action: 'report.read',
        targetType: 'interview',
        targetId: interviewId,
      }),
  });
  deps.profileService?.attachBlocks((a, b) => stores.blocks.existsEither(a, b));
  deps.briefs.attachCompletedTrials((founderId) =>
    stores.sprints.countCompletedForFounder(founderId),
  );
  return { collaboration, sprints, safety, audit };
}
