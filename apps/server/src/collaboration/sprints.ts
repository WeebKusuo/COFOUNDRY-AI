import { randomBytes } from 'node:crypto';
import {
  ACKNOWLEDGEMENT_NOTICE,
  SPRINT_LIMITS as L,
  TERMINAL_SPRINT_STATUSES,
  VERSIONS,
  checkSubmissionUrl,
  deadlineIssue,
  isNonMonetary,
  overallOutcome,
  publicReason,
  sprintProposalIssues,
  type FieldIssue,
  type SprintAction,
  type SprintApproveBody,
  type SprintProposalInput,
  type SprintReviewBody,
  type SprintSubmitBody,
  type SprintTerms,
  type SprintView,
} from '@cofoundry/shared';
import type { AuditContext } from '../audit/audit.js';
import type { UserRecord } from '../auth/store.js';
import type { Tx } from '../db/transactions.js';
import { isDuplicateKey } from '../db/record-collection.js';
import { AppError } from '../http/errors.js';
import { canonicalJson, sha256Hex } from '../lib/canonical-json.js';
import {
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
} from './common.js';
import type { MatchRecord, TrialSprintRecord } from './records.js';
import { cancelSprintRecord, type CollaborationDeps } from './requests.js';

/**
 * Phases 12-13 — the trial sprint state machine (Contract Sections 12, 13, 16, 20).
 *
 * One sprint per match. Terms are versioned; every edit increments the version, recomputes the
 * canonical terms hash and clears all approvals. A sprint becomes active only when BOTH
 * participants hold an approval of the same version and hash (the server records the
 * proposer's at send and the other participant's at approve; identities come from the session,
 * never the body). The candidate submits one HTTPS link (never fetched), the founder reviews every
 * criterion once, and both acknowledge the outcome to complete it. Deadlines and the 7-day review
 * and acknowledgement windows are enforced in every handler and by the 60-second sweep; a missed
 * window cancels the sprint, ends the match and keeps the history.
 */

type Role = 'founder' | 'candidate';

/** Section 13: hash covers scope, deliverables, criteria, hours, deadline, compensation and IP. */
export function termsHashOf(t: SprintTerms): string {
  return sha256Hex(
    canonicalJson({
      scope: t.scope,
      deliverables: t.deliverables,
      criteria: t.criteria,
      expectedHours: t.expectedHours,
      deadline: t.deadline,
      compensation: t.compensation,
      ipPolicyVersion: t.ipPolicyVersion,
    }),
  );
}

const criterionId = () => `c_${randomBytes(4).toString('hex')}`;

function fieldErrors(issues: FieldIssue[]): AppError {
  const fe: Record<string, string[]> = {};
  for (const i of issues) (fe[i.field] ??= []).push(i.message);
  return new AppError('VALIDATION_FAILED', 'Some fields are invalid.', { fieldErrors: fe });
}

function normalizeInput(input: SprintProposalInput): SprintProposalInput {
  const t = Date.parse(input.deadline);
  return {
    title: input.title.trim(),
    scope: input.scope.trim(),
    deliverables: input.deliverables.map((d) => d.trim()),
    criteria: input.criteria.map((c) => c.trim()),
    expectedHours: input.expectedHours,
    deadline: Number.isFinite(t) ? new Date(t).toISOString() : input.deadline,
    compensation: input.compensation,
  };
}

function termsFrom(input: SprintProposalInput, previous: SprintTerms | null): SprintTerms {
  // Unchanged criterion text at the same position keeps its id; anything new gets a fresh id.
  const criteria = input.criteria.map((text, i) => {
    const prev = previous?.criteria[i];
    return { id: prev && prev.text === text ? prev.id : criterionId(), text };
  });
  return {
    title: input.title,
    scope: input.scope,
    deliverables: input.deliverables,
    criteria,
    expectedHours: input.expectedHours,
    deadline: input.deadline,
    compensation: input.compensation,
    ipPolicyVersion: VERSIONS.ipPolicy,
  };
}

const inputOf = (t: SprintTerms): SprintProposalInput => ({
  title: t.title,
  scope: t.scope,
  deliverables: t.deliverables,
  criteria: t.criteria.map((c) => c.text),
  expectedHours: t.expectedHours,
  deadline: t.deadline,
  compensation: t.compensation,
});

export class SprintService {
  constructor(private readonly deps: CollaborationDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private roleOf(s: TrialSprintRecord, user: UserRecord): Role | null {
    return participantRole(s, user);
  }

  private userIdFor(s: TrialSprintRecord, role: Role): string {
    return role === 'founder' ? s.founderUserId : s.candidateUserId;
  }

  // --- Create / read --------------------------------------------------------------------------------

  async create(
    user: UserRecord,
    matchId: string,
    raw: SprintProposalInput,
    id: string,
    ctx: AuditContext = {},
  ): Promise<SprintView> {
    const same = await this.deps.sprints.findById(id);
    if (same) {
      if (!this.roleOf(same, user)) throw notFound();
      return this.view(user, same);
    }
    const match = await this.deps.matches.findById(matchId);
    const role = match ? participantRole(match, user) : null;
    if (!match || !role) throw notFound();
    if (match.status !== 'active')
      throw invalid('A sprint can be proposed only on an active match.');
    if (match.sprintId) throw invalid('This match already has its one trial sprint.');
    await this.assertPairAvailable(match);
    const input = normalizeInput(raw);
    const issues = sprintProposalIssues(input, match.termsSnapshot.compensation, this.now());
    if (issues.length > 0) throw fieldErrors(issues);
    const now = this.now();
    const terms = termsFrom(input, null);
    const termsHash = termsHashOf(terms);
    const record: TrialSprintRecord = {
      id,
      rev: 0,
      matchId: match.id,
      founderUserId: match.founderUserId,
      candidateUserId: match.candidateUserId,
      proposerUserId: user.id,
      contributorUserId: match.candidateUserId,
      reviewerUserId: match.founderUserId,
      version: 1,
      termsHash,
      terms,
      minimumCompensation: match.termsSnapshot.compensation,
      approvals: [],
      history: [{ version: 1, terms, termsHash, changedAt: now, changedBy: user.id }],
      status: 'proposed',
      sentAt: null,
      startedAt: null,
      submittedAt: null,
      reviewedAt: null,
      completedAt: null,
      cancelledAt: null,
      submission: null,
      review: null,
      acknowledgements: [],
      terminalReason: null,
      terminalNote: null,
      timeline: [{ at: now, event: 'Proposal drafted (version 1)', actor: role }],
      createdAt: now,
      updatedAt: now,
    };
    try {
      const saved = await this.deps.tx.run(async (tx) => {
        await this.deps.guards.touch(match.founderUserId, match.candidateUserId, tx);
        await this.assertPairAvailable(match, tx);
        const m = await this.deps.matches.findById(match.id, tx);
        if (!m || m.status !== 'active') throw invalid('This match is no longer active.');
        if (m.sprintId) throw invalid('This match already has its one trial sprint.');
        const ins = await this.deps.sprints.insert(record, tx);
        if (ins === 'duplicate') throw invalid('This match already has its one trial sprint.');
        const linked = await this.deps.matches.replace(
          withEvent({ ...m, sprintId: id, updatedAt: now }, 'Trial sprint proposed', role, now),
          m.rev,
          tx,
        );
        if (!linked) throw new AppError('VERSION_CONFLICT', 'The match changed. Try again.');
        await this.audit(user, 'sprint.created', id, ctx, tx);
        return (await this.deps.sprints.findById(id, tx))!;
      });
      return this.view(user, saved);
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const again = await this.deps.sprints.findById(id);
      if (again && this.roleOf(again, user)) return this.view(user, again);
      throw invalid('This match already has its one trial sprint.');
    }
  }

  async get(user: UserRecord, id: string): Promise<SprintView> {
    const s = await this.deps.sprints.findById(id);
    if (!s || !this.roleOf(s, user)) throw notFound();
    return this.view(user, await this.reconciled(s));
  }

  private async assertPairAvailable(m: MatchRecord, tx?: Tx): Promise<void> {
    if (await this.deps.blocks.existsEither(m.founderUserId, m.candidateUserId, tx))
      throw unavailable();
    const [f, c] = await Promise.all([
      this.deps.identity.findUserById(m.founderUserId),
      this.deps.identity.findUserById(m.candidateUserId),
    ]);
    if (!bothActive(f, c)) throw unavailable();
  }

  // --- Time rules -------------------------------------------------------------------------------------

  /** The cancellation a passed deadline or window requires now, or null. */
  private dueCancellation(s: TrialSprintRecord, now: Date): TrialSprintRecord['terminalReason'] {
    const t = now.getTime();
    const deadline = Date.parse(s.terms.deadline);
    if ((s.status === 'proposed' || s.status === 'awaiting_approval') && t >= deadline)
      return 'proposal_expired';
    if (s.status === 'active' && t >= deadline) return 'deadline_missed';
    if (
      s.status === 'submitted' &&
      s.submittedAt &&
      t >= s.submittedAt.getTime() + L.reviewWindowMs
    )
      return 'review_timeout';
    if (
      s.status === 'reviewed' &&
      s.reviewedAt &&
      t >= s.reviewedAt.getTime() + L.acknowledgementWindowMs
    )
      return 'acknowledgement_timeout';
    return null;
  }

  /** Applies a due cancellation (and ends the match) in its own transaction. */
  private async reconciled(s: TrialSprintRecord): Promise<TrialSprintRecord> {
    const reason = this.dueCancellation(s, this.now());
    if (!reason) return s;
    return (
      (await this.deps.tx
        .run(async (tx) => {
          await this.deps.guards.touch(s.founderUserId, s.candidateUserId, tx);
          const cur = await this.deps.sprints.findById(s.id, tx);
          if (!cur) return null;
          const due = this.dueCancellation(cur, this.now());
          if (!due) return cur;
          return this.cancelInTx(cur, due, null, 'system', tx);
        })
        .catch(() => null)) ??
      (await this.deps.sprints.findById(s.id)) ??
      s
    );
  }

  private async cancelInTx(
    s: TrialSprintRecord,
    reason: NonNullable<TrialSprintRecord['terminalReason']>,
    note: string | null,
    actor: Role | 'system',
    tx: Tx,
  ): Promise<TrialSprintRecord> {
    const now = this.now();
    const next = cancelSprintRecord(s, reason, note, actor, now);
    const saved = await this.deps.sprints.replace(next, s.rev, tx);
    if (!saved) throw new AppError('VERSION_CONFLICT', 'The sprint changed. Try again.');
    const m = await this.deps.matches.findById(s.matchId, tx);
    if (m && m.status === 'active') {
      const ended = withEvent(
        {
          ...m,
          status: 'ended' as const,
          endedAt: now,
          endReason:
            reason === 'rejected' ? ('sprint_rejected' as const) : ('sprint_cancelled' as const),
          endNote: null,
          updatedAt: now,
        },
        reason === 'rejected' ? 'Match ended: proposal rejected' : 'Match ended: sprint cancelled',
        actor,
        now,
      );
      if (!(await this.deps.matches.replace(ended, m.rev, tx)))
        throw new AppError('VERSION_CONFLICT', 'The match changed. Try again.');
    }
    return saved;
  }

  /** 60-second job: proposal expiry, missed deadlines, review and acknowledgement timeouts. */
  async sweep(): Promise<number> {
    const now = this.now();
    const ids = await this.deps.sprints.findDueIds(
      now,
      new Date(now.getTime() - L.reviewWindowMs),
      new Date(now.getTime() - L.acknowledgementWindowMs),
      200,
    );
    let n = 0;
    for (const id of ids) {
      const s = await this.deps.sprints.findById(id);
      if (!s) continue;
      const after = await this.reconciled(s);
      if (after.status === 'cancelled' && s.status !== 'cancelled') n += 1;
    }
    return n;
  }

  // --- Transitions ------------------------------------------------------------------------------------

  /**
   * Runs one transition: reconciles time rules first (committed on their own), then — in a
   * transaction guarded by the pair's RelationshipGuard — re-reads the sprint, checks the pair is
   * still available and applies `change`. `change` returns the next record, or the current one
   * for an idempotent repeat.
   */
  private async transition(
    user: UserRecord,
    id: string,
    action: string,
    change: (
      s: TrialSprintRecord,
      role: Role,
      now: Date,
      tx: Tx,
    ) => Promise<{
      next: TrialSprintRecord;
      match?: (m: MatchRecord) => MatchRecord | null;
    } | null>,
    ctx: AuditContext,
  ): Promise<SprintView> {
    const pre = await this.deps.sprints.findById(id);
    const role = pre ? this.roleOf(pre, user) : null;
    if (!pre || !role) throw notFound();
    const s0 = await this.reconciled(pre);
    if (
      s0.status === 'cancelled' &&
      pre.status !== 'cancelled' &&
      s0.terminalReason !== 'participant_cancelled'
    )
      throw new AppError('EXPIRED', 'This sprint’s deadline or review window has passed.');
    const saved = await this.deps.tx.run(async (tx) => {
      await this.deps.guards.touch(s0.founderUserId, s0.candidateUserId, tx);
      const s = await this.deps.sprints.findById(id, tx);
      if (!s) throw notFound();
      const now = this.now();
      if (this.dueCancellation(s, now))
        throw new AppError('EXPIRED', 'This sprint’s deadline or review window has passed.');
      const out = await change(s, role, now, tx);
      if (!out) return s; // idempotent repeat of an already-reached state
      if (!TERMINAL_SPRINT_STATUSES.includes(s.status)) {
        const m = await this.deps.matches.findById(s.matchId, tx);
        if (!m) throw notFound();
        if (out.next.status !== 'cancelled') {
          if (m.status !== 'active') throw invalid('This match is no longer active.');
          if (await this.deps.blocks.existsEither(s.founderUserId, s.candidateUserId, tx))
            throw unavailable();
        }
      }
      const written = await this.deps.sprints.replace(out.next, s.rev, tx);
      if (!written)
        throw new AppError('VERSION_CONFLICT', 'The sprint changed. Reload and try again.');
      if (out.match) {
        const m = await this.deps.matches.findById(s.matchId, tx);
        const mNext = m ? out.match(m) : null;
        if (m && mNext && !(await this.deps.matches.replace(mNext, m.rev, tx)))
          throw new AppError('VERSION_CONFLICT', 'The match changed. Try again.');
      }
      await this.audit(user, action, id, ctx, tx, { version: written.version });
      return written;
    });
    return this.view(user, saved);
  }

  async patch(
    user: UserRecord,
    id: string,
    body: { expectedVersion: number; changes: Partial<SprintProposalInput> },
    ctx: AuditContext = {},
  ) {
    return this.transition(
      user,
      id,
      'sprint.revised',
      async (s, role, now) => {
        if (s.proposerUserId !== user.id) throw forbidden('Only the proposer can edit the terms.');
        if (s.status !== 'proposed' && s.status !== 'awaiting_approval')
          throw invalid('Terms can no longer be edited.');
        if (body.expectedVersion !== s.version)
          throw new AppError('VERSION_CONFLICT', 'The terms changed. Review the latest version.');
        const input = normalizeInput({ ...inputOf(s.terms), ...body.changes });
        const issues = sprintProposalIssues(input, s.minimumCompensation, now);
        if (issues.length > 0) throw fieldErrors(issues);
        const terms = termsFrom(input, s.terms);
        const termsHash = termsHashOf(terms);
        const version = s.version + 1;
        return {
          next: withEvent(
            {
              ...s,
              version,
              terms,
              termsHash,
              // Any change invalidates every earlier approval (SPR-01).
              approvals: [],
              status: 'proposed' as const,
              history: [
                ...s.history,
                { version, terms, termsHash, changedAt: now, changedBy: user.id },
              ],
              updatedAt: now,
            },
            `Terms revised (version ${version}); earlier approvals no longer count`,
            role,
            now,
          ),
        };
      },
      ctx,
    );
  }

  async send(
    user: UserRecord,
    id: string,
    body: { expectedVersion: number; acknowledgeUnpaid?: boolean },
    ctx: AuditContext = {},
  ) {
    return this.transition(
      user,
      id,
      'sprint.sent',
      async (s, role, now) => {
        if (s.proposerUserId !== user.id)
          throw forbidden('Only the proposer can send the proposal.');
        if (s.status === 'awaiting_approval' && body.expectedVersion === s.version) return null;
        if (s.status !== 'proposed') throw invalid('Only a draft proposal can be sent.');
        if (body.expectedVersion !== s.version)
          throw new AppError('VERSION_CONFLICT', 'The terms changed. Review the latest version.');
        const issues = sprintProposalIssues(inputOf(s.terms), s.minimumCompensation, now);
        if (issues.length > 0) throw fieldErrors(issues);
        this.requireUnpaidAck(s, body.acknowledgeUnpaid);
        return {
          next: withEvent(
            {
              ...s,
              status: 'awaiting_approval' as const,
              sentAt: now,
              approvals: [
                { userId: user.id, version: s.version, termsHash: s.termsHash, approvedAt: now },
              ],
              updatedAt: now,
            },
            `Version ${s.version} sent and approved by the proposer`,
            role,
            now,
          ),
        };
      },
      ctx,
    );
  }

  private requireUnpaidAck(s: TrialSprintRecord, ack: boolean | undefined) {
    if (isNonMonetary(s.terms.compensation)) {
      if (ack !== true)
        throw new AppError(
          'VALIDATION_FAILED',
          'Acknowledge that no monetary payment is promised.',
          {
            fieldErrors: { acknowledgeUnpaid: ['Required for credit/reference or unpaid terms.'] },
          },
        );
    } else if (ack === true) {
      throw new AppError(
        'VALIDATION_FAILED',
        'These terms are paid; there is nothing to acknowledge.',
        {
          fieldErrors: { acknowledgeUnpaid: ['Leave this unset for paid terms.'] },
        },
      );
    }
  }

  async approve(user: UserRecord, id: string, body: SprintApproveBody, ctx: AuditContext = {}) {
    return this.transition(
      user,
      id,
      'sprint.approved',
      async (s, role, now) => {
        if (s.proposerUserId === user.id)
          throw forbidden('Your approval was recorded when you sent the proposal.');
        if (
          s.status === 'active' &&
          s.approvals.some(
            (a) =>
              a.userId === user.id &&
              a.version === body.expectedVersion &&
              a.termsHash === body.termsHash,
          )
        )
          return null;
        if (s.status !== 'awaiting_approval')
          throw invalid('There is no proposal waiting for approval.');
        if (body.expectedVersion !== s.version || body.termsHash !== s.termsHash)
          throw new AppError(
            'VERSION_CONFLICT',
            'These are not the current terms. Review the latest version before approving.',
          );
        const d = deadlineIssue(s.terms.deadline, now);
        if (d) throw invalid(`The proposal can no longer be approved: ${d.message}`);
        this.requireUnpaidAck(s, body.acknowledgeUnpaid);
        const approvals = [
          ...s.approvals.filter((a) => a.userId !== user.id),
          { userId: user.id, version: s.version, termsHash: s.termsHash, approvedAt: now },
        ];
        // Both participants must hold an approval of exactly this version and hash.
        const both = [s.founderUserId, s.candidateUserId].every((uid) =>
          approvals.some(
            (a) => a.userId === uid && a.version === s.version && a.termsHash === s.termsHash,
          ),
        );
        if (!both)
          throw new AppError('VERSION_CONFLICT', 'The proposer’s approval is not for these terms.');
        return {
          next: withEvent(
            { ...s, approvals, status: 'active' as const, startedAt: now, updatedAt: now },
            `Version ${s.version} approved by both — sprint active`,
            role,
            now,
          ),
        };
      },
      ctx,
    );
  }

  async reject(
    user: UserRecord,
    id: string,
    body: { expectedVersion: number; reason: string },
    ctx: AuditContext = {},
  ) {
    const view = await this.transition(
      user,
      id,
      'sprint.rejected',
      async (s, role, now) => {
        if (s.proposerUserId === user.id)
          throw forbidden('The proposer cannot reject; cancel instead.');
        if (s.status === 'rejected') return null;
        if (s.status !== 'awaiting_approval')
          throw invalid('Only a sent proposal can be rejected.');
        if (body.expectedVersion !== s.version)
          throw new AppError('VERSION_CONFLICT', 'The terms changed. Review the latest version.');
        return {
          next: withEvent(
            {
              ...s,
              status: 'rejected' as const,
              terminalReason: 'rejected' as const,
              terminalNote: body.reason.trim(),
              approvals: [],
              cancelledAt: now,
              updatedAt: now,
            },
            'Proposal rejected',
            role,
            now,
          ),
          match: (m) =>
            m.status === 'active'
              ? withEvent(
                  {
                    ...m,
                    status: 'ended' as const,
                    endedAt: now,
                    endReason: 'sprint_rejected' as const,
                    updatedAt: now,
                  },
                  'Match ended: proposal rejected',
                  role,
                  now,
                )
              : null,
        };
      },
      ctx,
    );
    return view;
  }

  async cancel(user: UserRecord, id: string, reason: string, ctx: AuditContext = {}) {
    return this.transition(
      user,
      id,
      'sprint.cancelled',
      async (s, role, now) => {
        if (s.status === 'cancelled' && s.terminalReason === 'participant_cancelled') return null;
        if (TERMINAL_SPRINT_STATUSES.includes(s.status))
          throw invalid('This sprint has already ended.');
        return {
          next: cancelSprintRecord(s, 'participant_cancelled', reason.trim(), role, now),
          match: (m) =>
            m.status === 'active'
              ? withEvent(
                  {
                    ...m,
                    status: 'ended' as const,
                    endedAt: now,
                    endReason: 'sprint_cancelled' as const,
                    updatedAt: now,
                  },
                  'Match ended: sprint cancelled',
                  role,
                  now,
                )
              : null,
        };
      },
      ctx,
    );
  }

  async submit(user: UserRecord, id: string, body: SprintSubmitBody, ctx: AuditContext = {}) {
    return this.transition(
      user,
      id,
      'sprint.submitted',
      async (s, role, now) => {
        if (s.contributorUserId !== user.id) throw forbidden('Only the contributor submits work.');
        if (s.status === 'submitted' && s.submission?.url === checkUrl(body.url)) return null;
        if (s.status !== 'active')
          throw invalid('Work can be submitted only while the sprint is active.');
        if (body.sharePermissionAcknowledged !== true)
          throw new AppError('VALIDATION_FAILED', 'Confirm the founder may view this link.', {
            fieldErrors: { sharePermissionAcknowledged: ['Required.'] },
          });
        const url = checkUrl(body.url);
        return {
          next: withEvent(
            {
              ...s,
              status: 'submitted' as const,
              submittedAt: now,
              submission: {
                url,
                note: (body.note ?? '').trim(),
                sharePermissionAcknowledged: true as const,
                submittedAt: now,
              },
              updatedAt: now,
            },
            'Work submitted',
            role,
            now,
          ),
        };
      },
      ctx,
    );
  }

  async review(user: UserRecord, id: string, body: SprintReviewBody, ctx: AuditContext = {}) {
    return this.transition(
      user,
      id,
      'sprint.reviewed',
      async (s, role, now) => {
        if (s.reviewerUserId !== user.id)
          throw forbidden('Only the founder reviews the submission.');
        if (s.status !== 'submitted') {
          if (s.review) throw invalid('The submission was already reviewed; a review is final.');
          throw invalid('There is no submission to review.');
        }
        const ids = s.terms.criteria.map((c) => c.id);
        const seen = new Set<string>();
        const fe: Record<string, string[]> = {};
        body.criteriaResults.forEach((r, i) => {
          if (!ids.includes(r.criterionId))
            fe[`criteriaResults.${i}.criterionId`] = ['Unknown criterion.'];
          else if (seen.has(r.criterionId))
            fe[`criteriaResults.${i}.criterionId`] = ['Reviewed twice.'];
          seen.add(r.criterionId);
        });
        for (const cid of ids)
          if (!seen.has(cid))
            fe.criteriaResults = ['Review every acceptance criterion exactly once.'];
        if (Object.keys(fe).length > 0)
          throw new AppError(
            'VALIDATION_FAILED',
            'Review every acceptance criterion exactly once.',
            { fieldErrors: fe },
          );
        const criteriaResults = ids.map((cid) => {
          const r = body.criteriaResults.find((x) => x.criterionId === cid)!;
          return { criterionId: cid, outcome: r.outcome, reason: r.reason.trim() };
        });
        return {
          next: withEvent(
            {
              ...s,
              status: 'reviewed' as const,
              reviewedAt: now,
              review: {
                version: 1 as const,
                criteriaResults,
                overallOutcome: overallOutcome(criteriaResults),
                summary: (body.summary ?? '').trim(),
                reviewedAt: now,
              },
              updatedAt: now,
            },
            'Founder reviewed the submission',
            role,
            now,
          ),
        };
      },
      ctx,
    );
  }

  async acknowledge(
    user: UserRecord,
    id: string,
    body: { reviewVersion: number; disagreementNote?: string },
    ctx: AuditContext = {},
  ) {
    return this.transition(
      user,
      id,
      'sprint.acknowledged',
      async (s, role, now) => {
        if (s.acknowledgements.some((a) => a.userId === user.id)) return null; // one each, final
        if (s.status !== 'reviewed') throw invalid('There is no review to acknowledge.');
        if (!s.review || body.reviewVersion !== s.review.version)
          throw new AppError('VERSION_CONFLICT', 'Acknowledge the current review.');
        const acknowledgements = [
          ...s.acknowledgements,
          {
            userId: user.id,
            reviewVersion: s.review.version,
            disagreementNote: (body.disagreementNote ?? '').trim(),
            at: now,
          },
        ];
        const complete = [s.founderUserId, s.candidateUserId].every((uid) =>
          acknowledgements.some((a) => a.userId === uid),
        );
        let next = withEvent(
          { ...s, acknowledgements, updatedAt: now },
          `${role === 'founder' ? 'Founder' : 'Candidate'} acknowledged the outcome`,
          role,
          now,
        );
        if (complete)
          next = withEvent(
            {
              ...next,
              status: 'completed' as const,
              completedAt: now,
              terminalReason: 'completed' as const,
            },
            'Trial completed',
            'system',
            now,
          );
        return {
          next,
          ...(complete
            ? {
                match: (m: MatchRecord) =>
                  m.status === 'active'
                    ? withEvent(
                        { ...m, status: 'completed' as const, endedAt: now, updatedAt: now },
                        'Match completed',
                        'system',
                        now,
                      )
                    : null,
              }
            : {}),
        };
      },
      ctx,
    );
  }

  private async audit(
    user: UserRecord,
    action: string,
    id: string,
    ctx: AuditContext,
    tx: Tx,
    metadata: Record<string, string | number | boolean | null> = {},
  ) {
    await this.deps.audit.record(
      { actorId: user.id, action, targetType: 'sprint', targetId: id, metadata },
      ctx,
      tx,
    );
  }

  // --- View -------------------------------------------------------------------------------------------

  async view(user: UserRecord, s: TrialSprintRecord): Promise<SprintView> {
    const role = this.roleOf(s, user)!;
    const users = await this.deps.identity.findUsersByIds([s.founderUserId, s.candidateUserId]);
    const by = new Map(users.map((u) => [u.id, u]));
    const blocked = await this.deps.blocks.existsEither(s.founderUserId, s.candidateUserId);
    const match = await this.deps.matches.findById(s.matchId);
    const live =
      !blocked &&
      bothActive(by.get(s.founderUserId), by.get(s.candidateUserId)) &&
      match?.status === 'active';
    const roleOfUser = (uid: string): Role => (uid === s.founderUserId ? 'founder' : 'candidate');
    const actions: SprintAction[] = [];
    const isProposer = s.proposerUserId === user.id;
    if (live) {
      switch (s.status) {
        case 'proposed':
          if (isProposer) actions.push('edit', 'send');
          actions.push('cancel');
          break;
        case 'awaiting_approval':
          if (isProposer) actions.push('edit');
          else actions.push('approve', 'reject');
          actions.push('cancel');
          break;
        case 'active':
          if (role === 'candidate') actions.push('submit');
          actions.push('cancel');
          break;
        case 'submitted':
          if (role === 'founder') actions.push('review');
          actions.push('cancel');
          break;
        case 'reviewed':
          if (!s.acknowledgements.some((a) => a.userId === user.id)) actions.push('acknowledge');
          actions.push('cancel');
          break;
        default:
          break;
      }
    }
    return {
      id: s.id,
      matchId: s.matchId,
      status: s.status,
      viewerRole: role,
      proposerRole: roleOfUser(s.proposerUserId),
      version: s.version,
      termsHash: s.termsHash,
      terms: s.terms,
      minimumCompensation: s.minimumCompensation,
      approvals: s.approvals.map((a) => ({
        role: roleOfUser(a.userId),
        version: a.version,
        termsHash: a.termsHash,
        approvedAt: a.approvedAt.toISOString(),
      })),
      history: s.history.map((h) => ({
        version: h.version,
        terms: h.terms,
        termsHash: h.termsHash,
        changedAt: h.changedAt.toISOString(),
        changedBy: roleOfUser(h.changedBy),
      })),
      createdAt: s.createdAt.toISOString(),
      sentAt: iso(s.sentAt),
      startedAt: iso(s.startedAt),
      submittedAt: iso(s.submittedAt),
      reviewedAt: iso(s.reviewedAt),
      completedAt: iso(s.completedAt),
      cancelledAt: iso(s.cancelledAt),
      submission: s.submission
        ? { ...s.submission, submittedAt: s.submission.submittedAt.toISOString() }
        : null,
      review: s.review ? { ...s.review, reviewedAt: s.review.reviewedAt.toISOString() } : null,
      acknowledgements: s.acknowledgements.map((a) => ({
        role: roleOfUser(a.userId),
        reviewVersion: a.reviewVersion,
        disagreementNote: a.disagreementNote,
        at: a.at.toISOString(),
      })),
      terminalReason: s.terminalReason ? publicReason(s.terminalReason) : null,
      terminalNote: s.terminalNote,
      reviewDueAt: s.submittedAt
        ? new Date(s.submittedAt.getTime() + L.reviewWindowMs).toISOString()
        : null,
      acknowledgementDueAt: s.reviewedAt
        ? new Date(s.reviewedAt.getTime() + L.acknowledgementWindowMs).toISOString()
        : null,
      timeline: timelineView(s.timeline),
      allowedActions: actions,
      founder: summaryOf(by.get(s.founderUserId), s.founderUserId),
      candidate: summaryOf(by.get(s.candidateUserId), s.candidateUserId),
      serverNow: this.now().toISOString(),
    };
  }

  /** The participant's user id with the given role (for tests and the safety service). */
  participant(s: TrialSprintRecord, role: Role): string {
    return this.userIdFor(s, role);
  }
}

function checkUrl(raw: string): string {
  const r = checkSubmissionUrl(raw);
  if (!r.ok)
    throw new AppError('VALIDATION_FAILED', r.message, { fieldErrors: { url: [r.message] } });
  return r.url;
}

export { ACKNOWLEDGEMENT_NOTICE };
