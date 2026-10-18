import mongoose from 'mongoose';
import {
  COLLABORATION_LIMITS as L,
  TRIAL_CAP_HOURS,
  VERSIONS,
  type CreateMatchRequestBody,
  type MatchAction,
  type MatchEndReason,
  type MatchRequestAction,
  type MatchRequestStatus,
  type MatchRequestView,
  type MatchStatus,
  type MatchView,
  type RequestWithdrawReason,
  type SprintSummary,
  type TermsSnapshot,
  publicReason,
} from '@cofoundry/shared';
import type { AuditContext, AuditLog } from '../audit/audit.js';
import type { IdentityStore, UserRecord } from '../auth/store.js';
import type { BriefRecord, BriefStore, PagePosition, PageRequest } from '../briefs/store.js';
import { isDuplicateKey } from '../db/record-collection.js';
import type { Tx, TransactionRunner } from '../db/transactions.js';
import { AppError } from '../http/errors.js';
import type { Logger } from '../lib/logger.js';
import { evaluateCandidate, prepareBrief } from '../matching/engine.js';
import type { ProfileStore } from '../profiles/store.js';
import { toMatchBrief, toMatchCandidate } from '../recommendations/service.js';
import type { BlockStore, RelationshipGuardStore } from '../safety/store.js';
import {
  NO_REPORT_SAFETY,
  bothActive,
  forbidden,
  invalid,
  iso,
  notFound,
  participantRole,
  summaryOf,
  timelineView,
  unavailable,
  withEvent,
  type InterviewFactsPort,
  type ReportSafetyPort,
} from './common.js';
import type { MatchRecord, MatchRequestRecord, TrialSprintRecord } from './records.js';
import type { MatchRequestStore, MatchStore, SprintStore } from './store.js';
import { TERMINAL_SPRINT_STATUSES } from '@cofoundry/shared';

/**
 * Phase 11 — collaboration requests and matches (Contract Sections 11, 16, 20, 25).
 *
 * One request per (brief, candidate) for the lifetime of the brief; accepting it creates exactly
 * one Match in the same transaction. Every paired mutation writes the RelationshipGuard row
 * first and re-reads block and account state inside the transaction, so a concurrent block or
 * suspension can never leave an active post-block relationship (SAFE-01). Expiry is enforced
 * synchronously in every handler and by the 60-second sweep; frontend timers are display only.
 */

export interface CollaborationDeps {
  requests: MatchRequestStore;
  matches: MatchStore;
  sprints: SprintStore;
  blocks: BlockStore;
  guards: RelationshipGuardStore;
  tx: TransactionRunner;
  identity: IdentityStore;
  briefStore: BriefStore;
  profiles: ProfileStore;
  interviews: InterviewFactsPort;
  audit: AuditLog;
  logger?: Logger;
  now?: () => Date;
}

const PENDING: MatchRequestStatus = 'pending';

export class CollaborationService {
  private reportSafety: ReportSafetyPort = NO_REPORT_SAFETY;

  constructor(private readonly deps: CollaborationDeps) {}

  /** Late binding: the safety service is constructed after this one. */
  attachReportSafety(port: ReportSafetyPort): void {
    this.reportSafety = port;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // --- Requests -----------------------------------------------------------------------------------

  async createRequest(
    founder: UserRecord,
    body: CreateMatchRequestBody,
    id: string,
    ctx: AuditContext = {},
  ): Promise<MatchRequestView> {
    const same = await this.deps.requests.findById(id);
    if (same) {
      if (same.founderUserId !== founder.id) throw notFound();
      return this.requestView(founder, same);
    }
    if (body.candidateUserId === founder.id)
      throw new AppError('BAD_REQUEST', 'You cannot send a request to yourself.');
    const brief = await this.deps.briefStore.findById(body.briefId);
    // Ownership first: another founder's brief must not reveal anything about its pairs.
    if (!brief || brief.founderUserId !== founder.id) throw notFound();
    const facts = await this.deps.interviews.collaborationFacts(body.interviewId);
    if (
      !facts ||
      facts.founderUserId !== founder.id ||
      facts.briefId !== body.briefId ||
      facts.candidateUserId !== body.candidateUserId
    ) {
      throw notFound();
    }
    if (brief.status !== 'open') throw invalid('The brief is closed; no new requests can be sent.');
    if (!facts.consentActive || facts.blocked) throw unavailable();
    if (!facts.evaluated || facts.reportVersion === null)
      throw invalid('Send a request after the interview report is complete.');
    if (facts.quarantined)
      throw invalid('This report is under moderator review and cannot support a new request.');
    const candidate = await this.deps.identity.findUserById(body.candidateUserId);
    if (
      !bothActive(founder, candidate) ||
      candidate!.cohortId !== founder.cohortId ||
      !candidate!.roles.includes('candidate')
    )
      throw unavailable();
    if (await this.deps.blocks.existsEither(founder.id, candidate!.id)) throw unavailable();
    await this.assertGates(brief, candidate!);
    if (await this.deps.requests.findByPair(body.briefId, body.candidateUserId)) {
      throw new AppError(
        'DUPLICATE_PAIR',
        'A collaboration request already exists for this candidate and brief. Each pair gets one.',
      );
    }
    const now = this.now();
    const sent = await this.deps.requests.countCreatedSince(
      founder.id,
      new Date(now.getTime() - 24 * 3600_000),
    );
    if (sent >= L.requestsPerFounderPerDay) {
      throw new AppError(
        'RATE_LIMITED',
        'You can send at most 20 collaboration requests per day.',
        {
          headers: { 'Retry-After': '3600' },
        },
      );
    }
    const candidateProfile = await this.deps.profiles.findCandidate(candidate!.id);
    const founderProfile = await this.deps.profiles.findFounder(founder.id);
    const record: MatchRequestRecord = {
      id,
      rev: 0,
      briefId: brief.id,
      candidateUserId: candidate!.id,
      founderUserId: founder.id,
      interviewId: facts.interviewId,
      reportVersion: facts.reportVersion,
      reportScore: facts.overallScore,
      reportEvidenceLevel: facts.evidenceLevel,
      message: body.message.trim(),
      termsSnapshot: termsOf(brief),
      profileSnapshots: {
        candidate: {
          userId: candidate!.id,
          displayName: candidate!.displayName,
          revision: candidateProfile?.revision ?? null,
          headline: candidateProfile?.headline ?? null,
        },
        founder: {
          userId: founder.id,
          displayName: founder.displayName,
          revision: founderProfile?.revision ?? null,
          headline: null,
        },
      },
      status: PENDING,
      expiresAt: new Date(now.getTime() + L.requestTtlMs),
      respondedAt: null,
      responseReason: null,
      withdrawReason: null,
      matchId: null,
      timeline: [{ at: now, event: 'Request sent', actor: 'founder' }],
      createdAt: now,
      updatedAt: now,
    };
    let created: MatchRequestRecord;
    try {
      created = await this.deps.tx.run(async (tx) => {
        await this.deps.guards.touch(founder.id, candidate!.id, tx);
        if (await this.deps.blocks.existsEither(founder.id, candidate!.id, tx)) throw unavailable();
        const res = await this.deps.requests.insert(record, tx);
        if (res === 'duplicate') throw duplicatePair();
        await this.deps.audit.record(
          {
            actorId: founder.id,
            action: 'match_request.created',
            targetType: 'match_request',
            targetId: id,
            metadata: { briefId: brief.id, interviewId: facts.interviewId },
          },
          ctx,
          tx,
        );
        return (await this.deps.requests.findById(id, tx))!;
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const again = await this.deps.requests.findById(id);
      if (again && again.founderUserId === founder.id) return this.requestView(founder, again);
      throw duplicatePair();
    }
    // Brief-close race (REQ-03): the close hook withdraws pending requests it can see; a request
    // committed after that listing is withdrawn here instead.
    const latest = await this.deps.briefStore.findById(brief.id);
    if (!latest || latest.status !== 'open') {
      created = (await this.withdrawAuto(created.id, 'brief_closed')) ?? created;
    }
    return this.requestView(founder, created);
  }

  private async assertGates(brief: BriefRecord, candidate: UserRecord): Promise<void> {
    const profile = await this.deps.profiles.findCandidate(candidate.id);
    const matchCandidate = profile ? toMatchCandidate({ user: candidate, profile }) : null;
    if (
      !matchCandidate ||
      !matchCandidate.opportunityTypes.includes('contributor') ||
      !evaluateCandidate(prepareBrief(toMatchBrief(brief)), matchCandidate).passed
    ) {
      throw new AppError(
        'GATE_CHANGED',
        'The candidate’s current profile no longer meets this brief’s requirements.',
      );
    }
  }

  async listRequests(
    user: UserRecord,
    box: 'inbox' | 'sent',
    filter: { status?: MatchRequestStatus; interviewId?: string },
    page: PageRequest,
  ): Promise<{ items: MatchRequestView[]; next: PagePosition | null }> {
    if (box === 'sent' && !user.roles.includes('founder'))
      throw forbidden('Only founders send collaboration requests.');
    if (box === 'inbox' && !user.roles.includes('candidate'))
      throw forbidden('Only candidates receive collaboration requests.');
    const rows = await this.deps.requests.list(
      {
        ...(box === 'sent' ? { founderUserId: user.id } : { candidateUserId: user.id }),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.interviewId ? { interviewId: filter.interviewId } : {}),
      },
      page,
    );
    const pageRows = rows.slice(0, page.limit);
    const items: MatchRequestView[] = [];
    for (const r of pageRows) items.push(await this.requestView(user, await this.reconciled(r)));
    const last = pageRows[pageRows.length - 1];
    return {
      items,
      next: rows.length > page.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }

  async getRequest(user: UserRecord, id: string): Promise<MatchRequestView> {
    const rec = await this.deps.requests.findById(id);
    if (!rec || !participantRole(rec, user)) throw notFound();
    return this.requestView(user, await this.reconciled(rec));
  }

  /** Synchronous expiry (Section 11): pending -> expired when now >= expiresAt. */
  private async reconciled(rec: MatchRequestRecord): Promise<MatchRequestRecord> {
    if (rec.status !== PENDING || this.now() < rec.expiresAt) return rec;
    return (await this.expire(rec.id)) ?? rec;
  }

  private async expire(id: string): Promise<MatchRequestRecord | null> {
    const cur = await this.deps.requests.findById(id);
    if (!cur || cur.status !== PENDING || this.now() < cur.expiresAt) return cur;
    const at = this.now();
    const next = withEvent(
      { ...cur, status: 'expired' as const, updatedAt: at },
      'Request expired after 7 days',
      'system',
      at,
    );
    return (await this.deps.requests.replace(next, cur.rev)) ?? this.deps.requests.findById(id);
  }

  async accept(
    user: UserRecord,
    id: string,
    ctx: AuditContext = {},
  ): Promise<{ request: MatchRequestView; match: MatchView }> {
    const pre = await this.deps.requests.findById(id);
    const role = pre ? participantRole(pre, user) : null;
    if (!pre || !role) throw notFound();
    if (role !== 'candidate') throw forbidden('Only the candidate can accept this request.');
    // Retry after success (or after a crash between the two writes) returns/repairs the match.
    if (pre.status === 'accepted') {
      const match = await this.ensureMatch(pre);
      return {
        request: await this.requestView(user, pre),
        match: await this.matchView(user, match),
      };
    }
    const rec = await this.reconciled(pre);
    if (rec.status === 'expired') throw new AppError('EXPIRED', 'This request has expired.');
    if (rec.status !== PENDING) throw invalid('This request is no longer pending.');
    const [founder, brief] = await Promise.all([
      this.deps.identity.findUserById(rec.founderUserId),
      this.deps.briefStore.findById(rec.briefId),
    ]);
    if (!brief || brief.status !== 'open')
      throw invalid('The brief has closed; this request can no longer be accepted.');
    if (!bothActive(founder, user)) throw unavailable();
    const facts = await this.deps.interviews.collaborationFacts(rec.interviewId);
    if (!facts || !facts.consentActive || facts.blocked) throw unavailable();
    await this.assertGates(brief, user);
    const matchId = new mongoose.Types.ObjectId().toHexString();
    let result: { request: MatchRequestRecord; match: MatchRecord };
    try {
      result = await this.deps.tx.run(async (tx) => {
        await this.deps.guards.touch(rec.founderUserId, rec.candidateUserId, tx);
        // Re-read everything after the guard write (Section 25).
        const cur = await this.deps.requests.findById(id, tx);
        if (!cur) throw notFound();
        const now = this.now();
        if (cur.status === 'accepted' && cur.matchId) {
          const m = await this.deps.matches.findById(cur.matchId, tx);
          if (m) return { request: cur, match: m };
        }
        if (cur.status !== PENDING) throw invalid('This request is no longer pending.');
        if (now >= cur.expiresAt) throw new AppError('EXPIRED', 'This request has expired.');
        if (await this.deps.blocks.existsEither(cur.founderUserId, cur.candidateUserId, tx))
          throw unavailable();
        const b = await this.deps.briefStore.findById(cur.briefId);
        if (!b || b.status !== 'open')
          throw invalid('The brief has closed; this request can no longer be accepted.');
        const [f, c] = await Promise.all([
          this.deps.identity.findUserById(cur.founderUserId),
          this.deps.identity.findUserById(cur.candidateUserId),
        ]);
        if (!bothActive(f, c)) throw unavailable();
        const accepted = withEvent(
          {
            ...cur,
            status: 'accepted' as const,
            respondedAt: now,
            matchId,
            updatedAt: now,
          },
          'Accepted by the candidate — match created',
          'candidate',
          now,
        );
        const saved = await this.deps.requests.replace(accepted, cur.rev, tx);
        if (!saved) {
          // Without transactions a concurrent accept can win the compare-and-set: return its
          // match (created with the id it stored) instead of an error.
          const winner = await this.deps.requests.findById(id, tx);
          if (winner?.status === 'accepted')
            return { request: winner, match: await this.ensureMatch(winner) };
          throw new AppError('VERSION_CONFLICT', 'The request changed. Try again.');
        }
        const match = newMatch(saved, matchId, now);
        const ins = await this.deps.matches.insert(match, tx);
        if (ins === 'duplicate') throw invalid('A match already exists for this pair.');
        await this.deps.audit.record(
          {
            actorId: user.id,
            action: 'match_request.accepted',
            targetType: 'match_request',
            targetId: id,
            metadata: { matchId },
          },
          ctx,
          tx,
        );
        return { request: saved, match: (await this.deps.matches.findById(matchId, tx)) ?? match };
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // A concurrent accept won: return the match it created to this participant (REQ-01).
      const after = await this.deps.requests.findById(id);
      if (after?.status === 'accepted') {
        const match = await this.ensureMatch(after);
        return {
          request: await this.requestView(user, after),
          match: await this.matchView(user, match),
        };
      }
      throw err;
    }
    // Brief-close race (REQ-03): a close that committed while this accept ran ends the new match.
    const after = await this.deps.briefStore.findById(result.request.briefId);
    if (!after || after.status !== 'open') {
      result.match = (await this.endRaceCreatedMatch(result.match.id)) ?? result.match;
    }
    return {
      request: await this.requestView(user, result.request),
      match: await this.matchView(user, result.match),
    };
  }

  private async endRaceCreatedMatch(matchId: string): Promise<MatchRecord | null> {
    return this.deps.tx
      .run(async (tx) => {
        const m = await this.deps.matches.findById(matchId, tx);
        if (!m || m.status !== 'active') return m;
        await this.deps.guards.touch(m.founderUserId, m.candidateUserId, tx);
        return this.endMatchInTx(matchId, 'brief_closed', 'system', null, tx);
      })
      .catch(() => null);
  }

  /** The match for an accepted request; recreated if a non-atomic crash lost it. */
  private async ensureMatch(req: MatchRequestRecord): Promise<MatchRecord> {
    const existing = await this.deps.matches.findByRequest(req.id);
    if (existing) return existing;
    const at = this.now();
    const match = newMatch(req, req.matchId ?? new mongoose.Types.ObjectId().toHexString(), at);
    const res = await this.deps.matches.insert(match);
    if (res === 'created' && req.matchId !== match.id) {
      await this.deps.requests.replace({ ...req, matchId: match.id, updatedAt: at }, req.rev);
    }
    return (await this.deps.matches.findByRequest(req.id)) ?? match;
  }

  async decline(user: UserRecord, id: string, reason: string, ctx: AuditContext = {}) {
    return this.respond(
      user,
      id,
      'candidate',
      async (cur, now) =>
        withEvent(
          {
            ...cur,
            status: 'declined' as const,
            respondedAt: now,
            responseReason: reason.trim() || null,
            updatedAt: now,
          },
          'Declined by the candidate',
          'candidate',
          now,
        ),
      ctx,
      'match_request.declined',
    );
  }

  async withdraw(user: UserRecord, id: string, reason: string, ctx: AuditContext = {}) {
    return this.respond(
      user,
      id,
      'founder',
      async (cur, now) =>
        withEvent(
          {
            ...cur,
            status: 'withdrawn' as const,
            respondedAt: now,
            responseReason: reason.trim() || null,
            withdrawReason: 'founder_withdrew' as const,
            updatedAt: now,
          },
          'Withdrawn by the founder',
          'founder',
          now,
        ),
      ctx,
      'match_request.withdrawn',
    );
  }

  private async respond(
    user: UserRecord,
    id: string,
    actorRole: 'founder' | 'candidate',
    change: (cur: MatchRequestRecord, now: Date) => Promise<MatchRequestRecord>,
    ctx: AuditContext,
    action: string,
  ): Promise<MatchRequestView> {
    const pre = await this.deps.requests.findById(id);
    const role = pre ? participantRole(pre, user) : null;
    if (!pre || !role) throw notFound();
    if (role !== actorRole)
      throw forbidden(
        actorRole === 'candidate'
          ? 'Only the candidate can decline this request.'
          : 'Only the founder can withdraw this request.',
      );
    const rec = await this.reconciled(pre);
    const target = action === 'match_request.declined' ? 'declined' : 'withdrawn';
    if (rec.status === target) return this.requestView(user, rec); // repeated by the same actor
    if (rec.status === 'expired') throw new AppError('EXPIRED', 'This request has expired.');
    if (rec.status !== PENDING) throw invalid('This request is no longer pending.');
    const saved = await this.deps.tx.run(async (tx) => {
      await this.deps.guards.touch(rec.founderUserId, rec.candidateUserId, tx);
      const cur = await this.deps.requests.findById(id, tx);
      if (!cur || cur.status !== PENDING) throw invalid('This request is no longer pending.');
      const now = this.now();
      if (now >= cur.expiresAt) throw new AppError('EXPIRED', 'This request has expired.');
      const next = await change(cur, now);
      const out = await this.deps.requests.replace(next, cur.rev, tx);
      if (!out) throw new AppError('VERSION_CONFLICT', 'The request changed. Try again.');
      await this.deps.audit.record(
        { actorId: user.id, action, targetType: 'match_request', targetId: id },
        ctx,
        tx,
      );
      return out;
    });
    return this.requestView(user, saved);
  }

  /** Automatic withdrawal (brief close, block, suspension). Returns null when not pending. */
  private async withdrawAuto(
    id: string,
    reason: Exclude<RequestWithdrawReason, 'founder_withdrew'>,
    tx?: Tx,
  ): Promise<MatchRequestRecord | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const cur = await this.deps.requests.findById(id, tx);
      if (!cur || cur.status !== PENDING) return null;
      const now = this.now();
      const next = withEvent(
        {
          ...cur,
          status: 'withdrawn' as const,
          respondedAt: now,
          withdrawReason: reason,
          updatedAt: now,
        },
        reason === 'brief_closed'
          ? 'Withdrawn: the brief closed'
          : 'Withdrawn: no longer available',
        'system',
        now,
      );
      const saved = await this.deps.requests.replace(next, cur.rev, tx);
      if (saved) return saved;
    }
    return null;
  }

  /**
   * Brief close (Section 11): pending requests for it are withdrawn. A match that an accept
   * created after the close committed (race) is ended too; earlier matches continue.
   */
  async onBriefClosed(briefId: string): Promise<number> {
    const pending = await this.deps.requests.findPendingForBrief(briefId);
    let n = 0;
    for (const r of pending) if (await this.withdrawAuto(r.id, 'brief_closed')) n += 1;
    const brief = await this.deps.briefStore.findById(briefId);
    if (brief?.closedAt) {
      for (const m of await this.deps.matches.findActiveForBrief(briefId)) {
        if (m.startedAt >= brief.closedAt && (await this.endRaceCreatedMatch(m.id))) n += 1;
      }
    }
    return n;
  }

  // --- Matches ------------------------------------------------------------------------------------

  async listMatches(
    user: UserRecord,
    role: 'founder' | 'candidate',
    filter: { status?: MatchStatus },
    page: PageRequest,
  ): Promise<{ items: MatchView[]; next: PagePosition | null }> {
    if (!user.roles.includes(role)) throw forbidden('You do not have this role.');
    const rows = await this.deps.matches.list(
      { userId: user.id, role, ...(filter.status ? { status: filter.status } : {}) },
      page,
    );
    const pageRows = rows.slice(0, page.limit);
    const items: MatchView[] = [];
    for (const m of pageRows) items.push(await this.matchView(user, m));
    const last = pageRows[pageRows.length - 1];
    return {
      items,
      next: rows.length > page.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }

  async getMatch(user: UserRecord, id: string): Promise<MatchView> {
    const m = await this.deps.matches.findById(id);
    if (!m || !participantRole(m, user)) throw notFound();
    return this.matchView(user, m);
  }

  /** Match end (Section 11): either participant from active; cancels an unfinished sprint. */
  async endMatch(user: UserRecord, id: string, reason: string, ctx: AuditContext = {}) {
    const pre = await this.deps.matches.findById(id);
    const role = pre ? participantRole(pre, user) : null;
    if (!pre || !role) throw notFound();
    if (pre.status === 'ended' && pre.endReason === 'participant_ended')
      return this.matchView(user, pre);
    if (pre.status !== 'active') throw invalid('This match is no longer active.');
    const saved = await this.deps.tx.run(async (tx) => {
      await this.deps.guards.touch(pre.founderUserId, pre.candidateUserId, tx);
      const out = await this.endMatchInTx(pre.id, 'participant_ended', role, reason.trim(), tx);
      if (!out) throw invalid('This match is no longer active.');
      await this.deps.audit.record(
        { actorId: user.id, action: 'match.ended', targetType: 'match', targetId: id },
        ctx,
        tx,
      );
      return out;
    });
    return this.matchView(user, saved);
  }

  /**
   * Ends an active match and cancels its unfinished sprint (approvals of a sprint that never
   * started are cleared). Used by match end, block and suspension. Null when not active.
   */
  async endMatchInTx(
    matchId: string,
    reason: MatchEndReason,
    actor: 'founder' | 'candidate' | 'system' | 'moderator',
    note: string | null,
    tx?: Tx,
  ): Promise<MatchRecord | null> {
    const m = await this.deps.matches.findById(matchId, tx);
    if (!m || m.status !== 'active') return null;
    const now = this.now();
    if (m.sprintId) {
      const s = await this.deps.sprints.findById(m.sprintId, tx);
      if (s && !TERMINAL_SPRINT_STATUSES.includes(s.status)) {
        const sprintReason =
          reason === 'blocked' || reason === 'account_suspended'
            ? reason
            : ('match_ended' as const);
        const cancelled = cancelSprintRecord(s, sprintReason, null, actor, now);
        if (!(await this.deps.sprints.replace(cancelled, s.rev, tx)))
          throw new AppError('VERSION_CONFLICT', 'The sprint changed. Try again.');
      }
    }
    const ended = withEvent(
      {
        ...m,
        status: 'ended' as const,
        endedAt: now,
        endReason: reason,
        endNote: note || null,
        updatedAt: now,
      },
      reason === 'participant_ended' ? 'Match ended' : 'Match ended automatically',
      actor,
      now,
    );
    const saved = await this.deps.matches.replace(ended, m.rev, tx);
    if (!saved) throw new AppError('VERSION_CONFLICT', 'The match changed. Try again.');
    return saved;
  }

  // --- Safety cascades (Phase 14) -----------------------------------------------------------------

  /**
   * Block/suspension effects between a pair inside the caller's transaction: pending requests
   * are withdrawn and active matches ended (their sprints cancelled). Records stay readable as
   * minimal history; nothing is revived by unblocking.
   */
  async terminatePairInTx(
    a: string,
    b: string,
    reason: 'blocked' | 'account_suspended',
    tx: Tx,
  ): Promise<{ requests: number; matches: number }> {
    let requests = 0;
    let matches = 0;
    for (const r of await this.deps.requests.findPendingInvolving(a, b, tx)) {
      if (await this.withdrawAuto(r.id, reason, tx)) requests += 1;
    }
    for (const m of await this.deps.matches.findActiveInvolving(a, b, tx)) {
      if (await this.endMatchInTx(m.id, reason, 'system', null, tx)) matches += 1;
    }
    return { requests, matches };
  }

  /** Every counterparty of `userId` with a pending request or active match. */
  async counterpartiesOf(userId: string): Promise<string[]> {
    const out = new Set<string>();
    for (const r of await this.deps.requests.findPendingInvolving(userId))
      out.add(r.founderUserId === userId ? r.candidateUserId : r.founderUserId);
    for (const m of await this.deps.matches.findActiveInvolving(userId))
      out.add(m.founderUserId === userId ? m.candidateUserId : m.founderUserId);
    return [...out];
  }

  /** Whether the two users share a request or match (legitimate visibility for safety actions). */
  async related(a: string, b: string): Promise<boolean> {
    if (await this.deps.matches.existsBetween(a, b)) return true;
    const reqs = await this.deps.requests.list(
      { founderUserId: a, candidateUserId: b },
      {
        after: null,
        limit: 1,
      },
    );
    if (reqs.length > 0) return true;
    const back = await this.deps.requests.list(
      { founderUserId: b, candidateUserId: a },
      {
        after: null,
        limit: 1,
      },
    );
    return back.length > 0;
  }

  // --- Sweeps -------------------------------------------------------------------------------------

  /** 60-second job: request expiry, accepted-without-match repair, dormant matches. */
  async sweep(): Promise<{ expired: number; repaired: number; dormant: number }> {
    const now = this.now();
    let expired = 0;
    for (const id of await this.deps.requests.findExpiredPendingIds(now, 200)) {
      const r = await this.expire(id);
      if (r?.status === 'expired') expired += 1;
    }
    let repaired = 0;
    // Accepted requests from the last day whose match is missing (non-transactional crash).
    for (const id of await this.deps.requests.findRecentlyAcceptedIds(
      new Date(now.getTime() - 24 * 3600_000),
      200,
    )) {
      if (await this.deps.matches.findByRequest(id)) continue;
      const r = await this.deps.requests.findById(id);
      if (r && r.status === 'accepted') {
        await this.ensureMatch(r);
        repaired += 1;
      }
    }
    let dormant = 0;
    const cutoff = new Date(now.getTime() - L.dormantMatchMs);
    for (const id of await this.deps.matches.findDormantIds(cutoff, 100)) {
      const ended = await this.deps.tx
        .run(async (tx) => {
          const m = await this.deps.matches.findById(id, tx);
          if (!m || m.status !== 'active' || m.sprintId || m.startedAt > cutoff) return null;
          await this.deps.guards.touch(m.founderUserId, m.candidateUserId, tx);
          return this.endMatchInTx(id, 'inactivity', 'system', null, tx);
        })
        .catch(() => null);
      if (ended) dormant += 1;
    }
    return { expired, repaired, dormant };
  }

  // --- Views --------------------------------------------------------------------------------------

  private async names(rec: { founderUserId: string; candidateUserId: string }) {
    const users = await this.deps.identity.findUsersByIds([rec.founderUserId, rec.candidateUserId]);
    const by = new Map(users.map((u) => [u.id, u]));
    return {
      founder: summaryOf(by.get(rec.founderUserId), rec.founderUserId),
      candidate: summaryOf(by.get(rec.candidateUserId), rec.candidateUserId),
      founderUser: by.get(rec.founderUserId),
      candidateUser: by.get(rec.candidateUserId),
    };
  }

  async requestView(user: UserRecord, r: MatchRequestRecord): Promise<MatchRequestView> {
    const role = participantRole(r, user)!;
    const n = await this.names(r);
    const blocked = await this.deps.blocks.existsEither(r.founderUserId, r.candidateUserId);
    const facts = await this.deps.interviews.collaborationFacts(r.interviewId);
    const now = this.now();
    const live = r.status === PENDING && now < r.expiresAt;
    // Withdrawn assessment consent or a block ends the founder's access to assessment facts.
    const assessmentHidden = !facts || !facts.consentActive || facts.blocked || blocked;
    const unavailableNow =
      blocked ||
      !bothActive(n.founderUser, n.candidateUser) ||
      r.withdrawReason === 'blocked' ||
      (live && assessmentHidden);
    const brief = live ? await this.deps.briefStore.findById(r.briefId) : null;
    const actions: MatchRequestAction[] = [];
    if (live && !unavailableNow) {
      if (role === 'candidate') {
        if (brief?.status === 'open') actions.push('accept');
        actions.push('decline');
      } else actions.push('withdraw');
    }
    if (r.status === 'accepted' && r.matchId) actions.push('view_match');
    return {
      id: r.id,
      status: r.status,
      viewerRole: role,
      briefId: r.briefId,
      briefTitle: r.termsSnapshot.title,
      interviewId: r.interviewId,
      reportVersion: r.reportVersion,
      message: r.message,
      terms: r.termsSnapshot,
      founder: n.founder,
      candidate: n.candidate,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      respondedAt: iso(r.respondedAt),
      responseReason: r.responseReason,
      withdrawReason: r.withdrawReason ? publicReason(r.withdrawReason) : null,
      matchId: r.matchId,
      report: {
        interviewId: r.interviewId,
        reportVersion: r.reportVersion,
        overallScore: role === 'founder' && assessmentHidden ? null : r.reportScore,
        evidenceLevel: role === 'founder' && assessmentHidden ? null : r.reportEvidenceLevel,
        openCorrections: await this.reportSafety.openCorrections(r.interviewId),
        quarantined: facts?.quarantined ?? false,
      },
      timeline: timelineView(r.timeline),
      allowedActions: actions,
      unavailable: unavailableNow,
      serverNow: now.toISOString(),
    };
  }

  async matchView(user: UserRecord, m: MatchRecord): Promise<MatchView> {
    const role = participantRole(m, user)!;
    const n = await this.names(m);
    const blocked = await this.deps.blocks.existsEither(m.founderUserId, m.candidateUserId);
    const sprint = m.sprintId ? await this.deps.sprints.findById(m.sprintId) : null;
    const unavailableNow =
      blocked ||
      !bothActive(n.founderUser, n.candidateUser) ||
      m.endReason === 'blocked' ||
      m.endReason === 'account_suspended';
    const actions: MatchAction[] = [];
    if (m.status === 'active' && !unavailableNow) {
      actions.push('end');
      if (!sprint) actions.push('propose_sprint');
    }
    return {
      id: m.id,
      requestId: m.requestId,
      status: m.status,
      viewerRole: role,
      briefId: m.briefId,
      briefTitle: m.termsSnapshot.title,
      terms: m.termsSnapshot,
      founder: n.founder,
      candidate: n.candidate,
      interviewId: m.interviewId,
      startedAt: m.startedAt.toISOString(),
      endedAt: iso(m.endedAt),
      endReason: m.endReason ? publicReason(m.endReason) : null,
      endNote: m.endNote,
      sprint: sprint ? sprintSummary(sprint) : null,
      allowedActions: actions,
      unavailable: unavailableNow,
      serverNow: this.now().toISOString(),
    };
  }
}

const duplicatePair = () =>
  new AppError(
    'DUPLICATE_PAIR',
    'A collaboration request already exists for this candidate and brief. Each pair gets one.',
  );

export function termsOf(brief: BriefRecord): TermsSnapshot {
  if (!brief.compensation || brief.hoursRequiredPerWeek === null || brief.commitmentMonths === null)
    throw invalid('The brief terms are incomplete.');
  const comp = brief.compensation;
  return {
    briefId: brief.id,
    briefVersion: brief.version,
    title: brief.title,
    hoursRequiredPerWeek: brief.hoursRequiredPerWeek,
    commitmentMonths: brief.commitmentMonths,
    compensation:
      comp.type === 'paid'
        ? {
            type: 'paid',
            amountMinor: comp.amountMinor ?? 0,
            currency: 'INR',
            payer: 'founder',
            paymentDueDays: comp.paymentDueDays ?? 0,
            methodNote: comp.methodNote,
          }
        : comp.type === 'credit_reference'
          ? { type: 'credit_reference', benefitDescription: comp.benefitDescription }
          : { type: 'unpaid' },
    ipPolicyVersion: VERSIONS.ipPolicy,
    trialCapHours: TRIAL_CAP_HOURS,
  };
}

function newMatch(req: MatchRequestRecord, id: string, at: Date): MatchRecord {
  return {
    id,
    rev: 0,
    requestId: req.id,
    briefId: req.briefId,
    founderUserId: req.founderUserId,
    candidateUserId: req.candidateUserId,
    interviewId: req.interviewId,
    status: 'active',
    termsSnapshot: req.termsSnapshot,
    startedAt: at,
    endedAt: null,
    endReason: null,
    endNote: null,
    sprintId: null,
    timeline: [{ at, event: 'Match created', actor: 'candidate' }],
    createdAt: at,
    updatedAt: at,
  };
}

export function sprintSummary(s: TrialSprintRecord): SprintSummary {
  return {
    id: s.id,
    status: s.status,
    version: s.version,
    title: s.terms.title,
    deadline: s.terms.deadline,
  };
}

/** Cancels a non-terminal sprint record (pure); unstarted approvals no longer count. */
export function cancelSprintRecord(
  s: TrialSprintRecord,
  reason: TrialSprintRecord['terminalReason'] & string,
  note: string | null,
  actor: 'founder' | 'candidate' | 'system' | 'moderator',
  at: Date,
): TrialSprintRecord {
  const unstarted = s.status === 'proposed' || s.status === 'awaiting_approval';
  return withEvent(
    {
      ...s,
      status: 'cancelled' as const,
      cancelledAt: at,
      terminalReason: reason,
      terminalNote: note,
      approvals: unstarted ? [] : s.approvals,
      updatedAt: at,
    },
    `Cancelled (${publicReason(reason).replace(/_/g, ' ')})`,
    actor,
    at,
  );
}
