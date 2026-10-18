import mongoose from 'mongoose';
import {
  SAFETY_LIMITS as L,
  type BlockView,
  type CaseContextView,
  type CaseReporterView,
  type CaseStatus,
  type CaseSummaryView,
  type CreateCorrectionBody,
  type CreateReportBody,
  type ReportTargetType,
  type ResolveCaseBody,
} from '@cofoundry/shared';
import type { AuditContext, AuditLog } from '../audit/audit.js';
import type { IdentityStore, UserRecord } from '../auth/store.js';
import type { BriefStore, PagePosition, PageRequest } from '../briefs/store.js';
import type { CollaborationService } from '../collaboration/requests.js';
import type { SprintStore } from '../collaboration/store.js';
import type { TransactionRunner } from '../db/transactions.js';
import { AppError } from '../http/errors.js';
import type { InterviewService } from '../interviews/service.js';
import type { Logger } from '../lib/logger.js';
import type { ProfileStore } from '../profiles/store.js';
import type { BlockRecord, SafetyCaseRecord } from './records.js';
import type { BlockStore, RelationshipGuardStore, SafetyCaseStore } from './store.js';

/**
 * Phase 14 — blocking, reports, corrections and moderation (Contract Sections 16, 21, 24, 25).
 *
 * - Blocks are directed; either direction stops new interaction. Creating one runs inside a
 *   transaction with the pair's RelationshipGuard and withdraws pending requests and ends active
 *   matches/sprints between the pair; pre-submit interviews are cancelled and the founder's
 *   access to the candidate's assessment ends. Unblocking removes only the caller's own record
 *   and never revives anything.
 * - Reports and corrections open a SafetyCase visible only to its reporter and, once claimed, the
 *   assigned moderator. Targets never see cases or reporter identities. A claim is a user claim,
 *   never a verified finding, until a moderator resolves it.
 * - Moderators claim, read the minimum evidence (audited), add notes and resolve. They can add an
 *   attributed display correction, quarantine a report or suspend the case's target user — never
 *   edit answers, numeric scores or consent history. Nothing is decided automatically.
 */

const notFound = () => new AppError('NOT_FOUND', 'The requested resource was not found.');
const invalid = (m: string) => new AppError('INVALID_STATE', m);
const OPEN: CaseStatus[] = ['open', 'in_review'];
const isHex = (id: string) => /^[a-f0-9]{24}$/.test(id);

export interface SafetyDeps {
  blocks: BlockStore;
  guards: RelationshipGuardStore;
  cases: SafetyCaseStore;
  tx: TransactionRunner;
  identity: IdentityStore;
  briefStore: BriefStore;
  profiles: ProfileStore;
  sprints: SprintStore;
  collaboration: CollaborationService;
  interviews: InterviewService;
  /** Founder discovery visibility (latest recommendation batches). */
  recentlyRecommended: (founderUserId: string, candidateUserId: string) => Promise<boolean>;
  audit: AuditLog;
  logger?: Logger;
  now?: () => Date;
}

export class SafetyService {
  constructor(private readonly deps: SafetyDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // --- Visibility -----------------------------------------------------------------------------------

  /**
   * Legitimate visibility of another user: an interview, request or match between the two, or
   * (for a founder) the candidate in one of their latest recommendation batches.
   */
  async related(user: UserRecord, otherId: string): Promise<boolean> {
    if (!isHex(otherId) || otherId === user.id) return false;
    if ((await this.deps.interviews.sessionsBetween(user.id, otherId)).length > 0) return true;
    if (await this.deps.collaboration.related(user.id, otherId)) return true;
    if (user.roles.includes('founder')) return this.deps.recentlyRecommended(user.id, otherId);
    return false;
  }

  // --- Blocks ---------------------------------------------------------------------------------------

  async block(user: UserRecord, targetUserId: string, ctx: AuditContext = {}): Promise<BlockView> {
    if (targetUserId === user.id) throw new AppError('BAD_REQUEST', 'You cannot block yourself.');
    const target = isHex(targetUserId) ? await this.deps.identity.findUserById(targetUserId) : null;
    if (!target || !(await this.related(user, targetUserId))) throw notFound();
    const at = this.now();
    const record: BlockRecord = {
      id: new mongoose.Types.ObjectId().toHexString(),
      blockerUserId: user.id,
      blockedUserId: targetUserId,
      createdAt: at,
    };
    const saved = await this.deps.tx.run(async (tx) => {
      await this.deps.guards.touch(user.id, targetUserId, tx);
      const b = await this.deps.blocks.insert(record, tx);
      const effects = await this.deps.collaboration.terminatePairInTx(
        user.id,
        targetUserId,
        'blocked',
        tx,
      );
      await this.deps.audit.record(
        {
          actorId: user.id,
          action: 'block.created',
          targetType: 'user',
          targetId: targetUserId,
          metadata: { requestsWithdrawn: effects.requests, matchesEnded: effects.matches },
        },
        ctx,
        tx,
      );
      return b;
    });
    // Interviews use optimistic per-record writes; they are cancelled after the block commits
    // (every interview action also re-checks the block, so nothing can start in between).
    await this.deps.interviews.onRelationshipBlocked(user.id, targetUserId, 'blocked');
    return {
      targetUserId,
      displayName: target.displayName,
      createdAt: saved.createdAt.toISOString(),
    };
  }

  async listBlocks(user: UserRecord): Promise<BlockView[]> {
    const rows = await this.deps.blocks.listByBlocker(user.id);
    const users = await this.deps.identity.findUsersByIds(rows.map((r) => r.blockedUserId));
    const by = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({
      targetUserId: r.blockedUserId,
      displayName: by.get(r.blockedUserId)?.displayName ?? 'Former user',
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Removes only the caller's own block; cancelled relationships stay cancelled (SAFE-01). */
  async unblock(user: UserRecord, targetUserId: string, ctx: AuditContext = {}): Promise<void> {
    if (!isHex(targetUserId)) throw notFound();
    const removed = await this.deps.blocks.remove(user.id, targetUserId);
    if (!removed) throw notFound();
    await this.deps.guards.touch(user.id, targetUserId);
    await this.deps.audit.record(
      { actorId: user.id, action: 'block.removed', targetType: 'user', targetId: targetUserId },
      ctx,
    );
  }

  // --- Reports and corrections --------------------------------------------------------------------

  /** Resolves a report target and checks the reporter's legitimate visibility of it. */
  private async resolveTarget(
    user: UserRecord,
    targetType: ReportTargetType,
    targetId: string,
  ): Promise<{ targetUserId: string | null }> {
    if (!isHex(targetId)) throw notFound();
    switch (targetType) {
      case 'user':
      case 'profile': {
        if (targetId === user.id)
          throw new AppError('BAD_REQUEST', 'Use a correction for your own profile.');
        if (!(await this.related(user, targetId))) throw notFound();
        return { targetUserId: targetId };
      }
      case 'brief': {
        const brief = await this.deps.briefStore.findById(targetId);
        if (!brief || brief.founderUserId === user.id) throw notFound();
        const related =
          (await this.deps.interviews.sessionsBetween(user.id, brief.founderUserId)).some(
            (s) => s.briefId === brief.id,
          ) || (await this.deps.collaboration.related(user.id, brief.founderUserId));
        if (!related) throw notFound();
        return { targetUserId: brief.founderUserId };
      }
      case 'report': {
        const facts = await this.deps.interviews.collaborationFacts(targetId);
        if (!facts || (facts.founderUserId !== user.id && facts.candidateUserId !== user.id))
          throw notFound();
        return { targetUserId: null };
      }
      case 'sprint': {
        const s = await this.deps.sprints.findById(targetId);
        if (!s || (s.founderUserId !== user.id && s.candidateUserId !== user.id)) throw notFound();
        return { targetUserId: s.founderUserId === user.id ? s.candidateUserId : s.founderUserId };
      }
    }
  }

  private async openCase(
    user: UserRecord,
    input: {
      kind: SafetyCaseRecord['kind'];
      category: SafetyCaseRecord['category'];
      targetType: ReportTargetType;
      targetId: string;
      targetUserId: string | null;
      text: string;
    },
    id: string,
    ctx: AuditContext,
  ): Promise<{ status: number; data: CaseReporterView }> {
    const same = await this.deps.cases.findById(id);
    if (same) {
      if (same.reporterUserId !== user.id) throw notFound();
      return { status: 201, data: this.reporterView(same) };
    }
    // Repeated submissions about the same target link to the open case (Section 23).
    const dup = await this.deps.cases.findOpenDuplicate(
      user.id,
      input.kind,
      input.targetType,
      input.targetId,
    );
    if (dup) return { status: 200, data: { ...this.reporterView(dup), linked: true } };
    const now = this.now();
    const recent = await this.deps.cases.countByReporterSince(
      user.id,
      new Date(now.getTime() - 24 * 3600_000),
    );
    if (recent >= L.casesPerUserPerDay)
      throw new AppError(
        'RATE_LIMITED',
        'You can open at most 10 cases per day. Your earlier cases are still being handled.',
        {
          headers: { 'Retry-After': '3600' },
        },
      );
    const record: SafetyCaseRecord = {
      id,
      rev: 0,
      kind: input.kind,
      category: input.category,
      reporterUserId: user.id,
      targetUserId: input.targetUserId,
      targetType: input.targetType,
      targetId: input.targetId,
      text: input.text.trim(),
      status: 'open',
      assignedModeratorId: null,
      resolutionText: null,
      correctionOverlay: null,
      quarantinedReport: false,
      suspendedTarget: false,
      hold: null,
      notes: [],
      openedAt: now,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.cases.insert(record);
    await this.deps.audit.record(
      {
        actorId: user.id,
        action: `case.opened`,
        targetType: 'safety_case',
        targetId: id,
        metadata: { kind: input.kind, targetType: input.targetType, category: input.category },
      },
      ctx,
    );
    return { status: 201, data: this.reporterView((await this.deps.cases.findById(id)) ?? record) };
  }

  async report(user: UserRecord, body: CreateReportBody, id: string, ctx: AuditContext = {}) {
    const { targetUserId } = await this.resolveTarget(user, body.targetType, body.targetId);
    return this.openCase(
      user,
      {
        kind: 'report',
        category: body.category,
        targetType: body.targetType,
        targetId: body.targetId,
        targetUserId,
        text: body.text,
      },
      id,
      ctx,
    );
  }

  /** Corrections: own profile, or own (candidate) interview report only (Section 21). */
  async correction(
    user: UserRecord,
    body: CreateCorrectionBody,
    id: string,
    ctx: AuditContext = {},
  ) {
    if (!isHex(body.targetId)) throw notFound();
    if (body.targetType === 'profile') {
      if (body.targetId !== user.id) throw notFound();
    } else {
      const facts = await this.deps.interviews.collaborationFacts(body.targetId);
      if (!facts || facts.candidateUserId !== user.id) throw notFound();
      if (!facts.evaluated)
        throw invalid('A correction can be requested once the report is ready.');
    }
    return this.openCase(
      user,
      {
        kind: 'correction',
        category: body.targetType === 'report' ? 'assessment_error' : null,
        targetType: body.targetType,
        targetId: body.targetId,
        targetUserId: null,
        text: body.text,
      },
      id,
      ctx,
    );
  }

  async myCases(user: UserRecord, page: PageRequest) {
    const rows = await this.deps.cases.list({ reporterUserId: user.id }, page);
    return this.paged(rows, page, (r) => this.reporterView(r));
  }

  async getMyCase(user: UserRecord, id: string): Promise<CaseReporterView> {
    const c = isHex(id) ? await this.deps.cases.findById(id) : null;
    if (!c || c.reporterUserId !== user.id) throw notFound();
    return this.reporterView(c);
  }

  // --- Moderation -----------------------------------------------------------------------------------

  async listCases(mod: UserRecord, status: CaseStatus | undefined, page: PageRequest) {
    const rows = await this.deps.cases.list(status ? { status } : {}, page);
    return this.paged(rows, page, (r) => this.summary(r, mod));
  }

  private async assigned(mod: UserRecord, id: string): Promise<SafetyCaseRecord> {
    const c = isHex(id) ? await this.deps.cases.findById(id) : null;
    if (!c) throw notFound();
    if (c.assignedModeratorId !== mod.id)
      throw new AppError('FORBIDDEN', 'Claim this case before reading its evidence.');
    await this.assertNotInvolved(mod, c);
    return c;
  }

  /**
   * Conflict of interest: a moderator who is the reporter, the target or a participant of the
   * reported report/sprint cannot handle the case (accounts may hold several roles).
   */
  private async assertNotInvolved(mod: UserRecord, c: SafetyCaseRecord): Promise<void> {
    const involved = new Set<string>([c.reporterUserId]);
    if (c.targetUserId) involved.add(c.targetUserId);
    if (c.targetType === 'report') {
      const f = await this.deps.interviews.collaborationFacts(c.targetId);
      if (f) involved.add(f.founderUserId).add(f.candidateUserId);
    } else if (c.targetType === 'sprint') {
      const s = await this.deps.sprints.findById(c.targetId);
      if (s) involved.add(s.founderUserId).add(s.candidateUserId);
    } else if (c.targetType === 'brief') {
      const b = await this.deps.briefStore.findById(c.targetId);
      if (b) involved.add(b.founderUserId);
    }
    if (involved.has(mod.id))
      throw new AppError(
        'FORBIDDEN',
        'You are involved in this case; another moderator must handle it.',
      );
  }

  /** One case summary for the queue (no content). */
  async caseSummary(mod: UserRecord, id: string): Promise<CaseSummaryView> {
    const c = isHex(id) ? await this.deps.cases.findById(id) : null;
    if (!c) throw notFound();
    return this.summary(c, mod);
  }

  /** Atomically assigns an unclaimed case to the calling moderator (open -> in_review). */
  async claim(mod: UserRecord, id: string, ctx: AuditContext = {}): Promise<CaseSummaryView> {
    const c = isHex(id) ? await this.deps.cases.findById(id) : null;
    if (!c) throw notFound();
    if (c.assignedModeratorId === mod.id && c.status === 'in_review') return this.summary(c, mod);
    if (c.status !== 'open' || c.assignedModeratorId)
      throw invalid('This case was already claimed by another moderator.');
    await this.assertNotInvolved(mod, c);
    const now = this.now();
    // Only an assigned open case may hold the minimum related evidence (Section 24).
    const holdable = c.targetType === 'report' || c.targetType === 'sprint';
    const next: SafetyCaseRecord = {
      ...c,
      status: 'in_review',
      assignedModeratorId: mod.id,
      hold: holdable
        ? {
            reason: 'Evidence kept while a moderator reviews this case.',
            scope: c.targetType,
            setAt: now,
            reviewAt: new Date(now.getTime() + L.holdReviewMs),
            releasedAt: null,
          }
        : null,
      updatedAt: now,
    };
    const saved = await this.deps.cases.replace(next, c.rev);
    if (!saved) throw invalid('This case was already claimed by another moderator.');
    await this.deps.audit.record(
      { actorId: mod.id, action: 'case.claimed', targetType: 'safety_case', targetId: id },
      ctx,
    );
    return this.summary(saved, mod);
  }

  /** Minimum target evidence and participant ids; assigned moderator only; audited. */
  async context(mod: UserRecord, id: string, ctx: AuditContext = {}): Promise<CaseContextView> {
    const c = await this.assigned(mod, id);
    await this.deps.audit.record(
      {
        actorId: mod.id,
        action: 'case.context_read',
        targetType: 'safety_case',
        targetId: id,
        metadata: { targetType: c.targetType },
      },
      ctx,
    );
    const participantIds = new Set<string>([c.reporterUserId]);
    if (c.targetUserId) participantIds.add(c.targetUserId);
    const evidence: Array<{ label: string; value: string }> = [];
    let quarantinable = false;
    switch (c.targetType) {
      case 'report': {
        const e = await this.deps.interviews.moderatorEvidence(c.targetId);
        if (e) {
          participantIds.add(e.founderUserId);
          participantIds.add(e.candidateUserId);
          evidence.push(...e.evidence);
          quarantinable = true;
        }
        break;
      }
      case 'sprint': {
        const s = await this.deps.sprints.findById(c.targetId);
        if (s) {
          participantIds.add(s.founderUserId);
          participantIds.add(s.candidateUserId);
          evidence.push(
            { label: 'Sprint status', value: `${s.status} (version ${s.version})` },
            { label: 'Terms', value: `${s.terms.title}\n${s.terms.scope}` },
            {
              label: 'Acceptance criteria',
              value: s.terms.criteria.map((x) => `• ${x.text}`).join('\n'),
            },
            {
              label: 'Submission',
              value: s.submission ? `${s.submission.url}\n${s.submission.note}` : 'None',
            },
            {
              label: 'Review',
              value: s.review
                ? `${s.review.overallOutcome}\n${s.review.criteriaResults.map((r) => `${r.outcome}: ${r.reason}`).join('\n')}`
                : 'None',
            },
            {
              label: 'Acknowledgements',
              value:
                s.acknowledgements
                  .map(
                    (a) =>
                      `${a.userId === s.founderUserId ? 'Founder' : 'Candidate'}: ${a.disagreementNote || 'no note'}`,
                  )
                  .join('\n') || 'None',
            },
          );
        }
        break;
      }
      case 'profile':
      case 'user': {
        const id2 = c.targetType === 'profile' ? c.targetId : c.targetUserId;
        const cand = id2 ? await this.deps.profiles.findCandidate(id2) : null;
        const fnd = id2 ? await this.deps.profiles.findFounder(id2) : null;
        if (cand)
          evidence.push({ label: 'Candidate profile', value: `${cand.headline}\n${cand.bio}` });
        if (fnd) evidence.push({ label: 'Founder profile', value: fnd.bio });
        if (id2) participantIds.add(id2);
        break;
      }
      case 'brief': {
        const b = await this.deps.briefStore.findById(c.targetId);
        if (b) evidence.push({ label: 'Brief', value: `${b.title}\n${b.teaser}` });
        break;
      }
    }
    const users = await this.deps.identity.findUsersByIds([...participantIds]);
    const related = (await this.deps.cases.findForTarget(c.targetType, c.targetId)).filter(
      (x) => x.id !== c.id && OPEN.includes(x.status),
    ).length;
    const base = this.summary(c, mod);
    return {
      case: {
        ...base,
        text: c.text,
        reporterUserId: c.reporterUserId,
        targetUserId: c.targetUserId,
        targetId: c.targetId,
        resolutionText: c.resolutionText,
        displayCorrection: c.correctionOverlay?.text ?? null,
        hold: c.hold
          ? {
              reason: c.hold.reason,
              scope: c.hold.scope,
              setAt: c.hold.setAt.toISOString(),
              reviewAt: c.hold.reviewAt.toISOString(),
              releasedAt: c.hold.releasedAt?.toISOString() ?? null,
            }
          : null,
        notes: c.notes.map((n) => ({
          text: n.text,
          at: n.at.toISOString(),
          by: 'moderator' as const,
        })),
        quarantinedReport: c.quarantinedReport,
        suspendedTarget: c.suspendedTarget,
      },
      participants: users.map((u) => ({
        userId: u.id,
        displayName: u.displayName,
        role:
          u.id === c.reporterUserId
            ? 'reporter'
            : u.id === c.targetUserId
              ? 'target'
              : 'participant',
        status: u.status,
      })),
      evidence:
        quarantinable || evidence.length > 0
          ? evidence
          : [{ label: 'Target', value: 'No longer available' }],
      relatedOpenCases: related,
    };
  }

  async addNote(mod: UserRecord, id: string, text: string, ctx: AuditContext = {}) {
    const c = await this.assigned(mod, id);
    if (c.status !== 'in_review') throw invalid('Notes can be added while the case is in review.');
    const at = this.now();
    const saved = await this.deps.cases.replace(
      { ...c, notes: [...c.notes, { text: text.trim(), at, moderatorId: mod.id }], updatedAt: at },
      c.rev,
    );
    if (!saved) throw new AppError('VERSION_CONFLICT', 'The case changed. Reload and try again.');
    await this.deps.audit.record(
      { actorId: mod.id, action: 'case.note_added', targetType: 'safety_case', targetId: id },
      ctx,
    );
    return this.context(mod, id, ctx);
  }

  async resolve(mod: UserRecord, id: string, body: ResolveCaseBody, ctx: AuditContext = {}) {
    const c = await this.assigned(mod, id);
    if (c.status !== 'in_review') throw invalid('Only a case in review can be resolved.');
    const fe: Record<string, string[]> = {};
    if (body.decision === 'dismissed' && (body.quarantineReport || body.suspendTarget))
      fe.decision = ['Quarantine or suspension requires decision "resolved".'];
    if (body.quarantineReport && c.targetType !== 'report')
      fe.quarantineReport = ['Only an interview report can be quarantined.'];
    if (body.suspendTarget && !c.targetUserId)
      fe.suspendTarget = ['This case has no target user to suspend.'];
    if (body.displayCorrection !== undefined && c.targetType !== 'report')
      fe.displayCorrection = ['A display correction applies to an interview report.'];
    if (body.displayCorrection !== undefined && body.decision !== 'resolved')
      fe.displayCorrection = ['A display correction requires decision "resolved".'];
    if (Object.keys(fe).length > 0)
      throw new AppError('VALIDATION_FAILED', 'Some fields are invalid.', { fieldErrors: fe });
    const at = this.now();
    const next: SafetyCaseRecord = {
      ...c,
      status: body.decision,
      resolutionText: body.resolutionText.trim(),
      correctionOverlay:
        body.displayCorrection !== undefined
          ? { text: body.displayCorrection.trim(), moderatorId: mod.id, at }
          : null,
      quarantinedReport: body.quarantineReport,
      suspendedTarget: body.suspendTarget,
      hold: c.hold ? { ...c.hold, releasedAt: at } : null,
      resolvedAt: at,
      updatedAt: at,
    };
    const saved = await this.deps.cases.replace(next, c.rev);
    if (!saved) throw new AppError('VERSION_CONFLICT', 'The case changed. Reload and try again.');
    if (body.quarantineReport) await this.deps.interviews.setReportQuarantine(c.targetId);
    if (body.suspendTarget && c.targetUserId) await this.suspend(c.targetUserId, mod, ctx);
    await this.deps.audit.record(
      {
        actorId: mod.id,
        action: 'case.resolved',
        targetType: 'safety_case',
        targetId: id,
        metadata: {
          decision: body.decision,
          quarantineReport: body.quarantineReport,
          suspendTarget: body.suspendTarget,
          displayCorrection: body.displayCorrection !== undefined,
        },
      },
      ctx,
    );
    return this.context(mod, id, ctx);
  }

  /**
   * Suspension (Section 21): revokes sessions and applies the deletion termination rules —
   * pending requests withdrawn, active matches/sprints ended, pre-submit interviews cancelled —
   * without erasing records.
   */
  private async suspend(userId: string, mod: UserRecord, ctx: AuditContext): Promise<void> {
    await this.deps.identity.suspendUser(userId);
    await this.deps.identity.deleteSessionsForUser(userId);
    for (const other of await this.deps.collaboration.counterpartiesOf(userId)) {
      await this.deps.tx.run(async (tx) => {
        await this.deps.guards.touch(userId, other, tx);
        await this.deps.collaboration.terminatePairInTx(userId, other, 'account_suspended', tx);
      });
    }
    await this.deps.interviews.onUserSuspended(userId);
    await this.deps.audit.record(
      { actorId: mod.id, action: 'user.suspended', targetType: 'user', targetId: userId },
      ctx,
    );
  }

  // --- Overlays and holds used by other services ----------------------------------------------------

  async reportOverlays(interviewId: string) {
    const rows = await this.deps.cases.findForTarget('report', interviewId);
    return {
      corrections: rows
        .filter((r) => r.status === 'resolved' && r.correctionOverlay)
        .map((r) => ({
          caseId: r.id,
          text: r.correctionOverlay!.text,
          at: r.correctionOverlay!.at.toISOString(),
          by: 'CoFoundry moderator' as const,
        })),
      openCorrections: rows.filter((r) => r.kind === 'correction' && OPEN.includes(r.status))
        .length,
    };
  }

  async openCorrections(interviewId: string): Promise<number> {
    return (await this.reportOverlays(interviewId)).openCorrections;
  }

  async heldSessionIds(): Promise<Set<string>> {
    const rows = await this.deps.cases.findActiveHolds();
    return new Set(rows.filter((r) => r.targetType === 'report').map((r) => r.targetId));
  }

  // --- Views ----------------------------------------------------------------------------------------

  private paged<T>(rows: SafetyCaseRecord[], page: PageRequest, map: (r: SafetyCaseRecord) => T) {
    const pageRows = rows.slice(0, page.limit);
    const last = pageRows[pageRows.length - 1];
    const next: PagePosition | null =
      rows.length > page.limit && last ? { createdAt: last.createdAt, id: last.id } : null;
    return { items: pageRows.map(map), next };
  }

  reporterView(c: SafetyCaseRecord): CaseReporterView {
    return {
      id: c.id,
      kind: c.kind,
      category: c.category,
      targetType: c.targetType,
      targetId: c.targetId,
      text: c.text,
      status: c.status,
      verified: c.status === 'resolved',
      resolutionText: c.resolutionText,
      displayCorrection: c.correctionOverlay?.text ?? null,
      hold:
        c.hold && !c.hold.releasedAt
          ? { reason: c.hold.reason, scope: c.hold.scope, reviewAt: c.hold.reviewAt.toISOString() }
          : null,
      openedAt: c.openedAt.toISOString(),
      resolvedAt: c.resolvedAt?.toISOString() ?? null,
    };
  }

  private summary(c: SafetyCaseRecord, mod: UserRecord): CaseSummaryView {
    return {
      id: c.id,
      kind: c.kind,
      category: c.category,
      targetType: c.targetType,
      status: c.status,
      assignedToMe: c.assignedModeratorId === mod.id,
      assigned: c.assignedModeratorId !== null,
      openedAt: c.openedAt.toISOString(),
      resolvedAt: c.resolvedAt?.toISOString() ?? null,
    };
  }
}
