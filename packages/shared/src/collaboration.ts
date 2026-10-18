import { CURRENCY, type VERSIONS } from './constants.js';
import {
  BRIEF_LIMITS,
  TRIAL_CAP_HOURS,
  type CompensationTerms,
  type CompensationType,
} from './brief.js';
import { textLength as chars } from './text.js';
import { checkHttpsUrl } from './url.js';

/**
 * Collaboration contracts (Phases 11-13; Implementation Contract v3.0 Sections 11-13, 16, 20).
 *
 * One pair, one request, one match: a founder sends a collaboration request for an evaluated
 * interview; the candidate accepts (creating exactly one Match) or declines; the founder may
 * withdraw while pending; pending requests expire after 7 days. A match holds at most one
 * versioned TrialSprint whose terms both participants approve by version AND canonical hash.
 */

export const COLLABORATION_CONTRACT_VERSION = 'collaboration-v1' as const;

export const COLLABORATION_LIMITS = {
  requestTtlMs: 7 * 24 * 3600_000,
  requestMessageMax: 1_000,
  reasonMax: 500,
  endReasonMin: 1,
  requestsPerFounderPerDay: 20,
  /** Active match with no sprint after 30 days ends (reason inactivity). */
  dormantMatchMs: 30 * 24 * 3600_000,
} as const;

// --- Requests -----------------------------------------------------------------------------------

export const MATCH_REQUEST_STATUSES = [
  'pending',
  'accepted',
  'declined',
  'withdrawn',
  'expired',
] as const;
export type MatchRequestStatus = (typeof MATCH_REQUEST_STATUSES)[number];

export const MATCH_REQUEST_STATUS_LABELS: Readonly<Record<MatchRequestStatus, string>> = {
  pending: 'Waiting for the candidate',
  accepted: 'Accepted — matched',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
};

/** Why a request was withdrawn: by the founder, or automatically (Section 11). */
export const REQUEST_WITHDRAW_REASONS = [
  'founder_withdrew',
  'brief_closed',
  'blocked',
  'account_suspended',
  /** View-only: blocks and suspensions are never named to the other person (Section 21). */
  'unavailable',
] as const;
export type RequestWithdrawReason = (typeof REQUEST_WITHDRAW_REASONS)[number];

export const MATCH_REQUEST_ACTIONS = ['accept', 'decline', 'withdraw', 'view_match'] as const;
export type MatchRequestAction = (typeof MATCH_REQUEST_ACTIONS)[number];

/** Terms frozen from the brief when the request is created (copied again into the match). */
export interface TermsSnapshot {
  briefId: string;
  briefVersion: number;
  title: string;
  hoursRequiredPerWeek: number;
  commitmentMonths: number;
  compensation: CompensationTerms;
  ipPolicyVersion: typeof VERSIONS.ipPolicy;
  trialCapHours: number;
}

export interface ParticipantSummary {
  userId: string;
  displayName: string;
  demoAccount: boolean;
}

export interface TimelineEntry {
  at: string;
  event: string;
  actor: 'founder' | 'candidate' | 'system' | 'moderator';
}

/** Report facts shown with a request (never the report text itself). */
export interface RequestReportSummary {
  interviewId: string;
  reportVersion: number;
  overallScore: number | null;
  evidenceLevel: string | null;
  /** Open correction cases are shown, but never block a human decision (Section 11). */
  openCorrections: number;
  quarantined: boolean;
}

export interface MatchRequestView {
  id: string;
  status: MatchRequestStatus;
  viewerRole: 'founder' | 'candidate';
  briefId: string;
  briefTitle: string;
  interviewId: string;
  reportVersion: number;
  message: string;
  terms: TermsSnapshot;
  founder: ParticipantSummary;
  candidate: ParticipantSummary;
  createdAt: string;
  expiresAt: string;
  respondedAt: string | null;
  responseReason: string | null;
  withdrawReason: RequestWithdrawReason | null;
  matchId: string | null;
  report: RequestReportSummary;
  timeline: TimelineEntry[];
  allowedActions: MatchRequestAction[];
  /** True when a block or suspension made this collaboration unavailable. */
  unavailable: boolean;
  serverNow: string;
}

export interface CreateMatchRequestBody {
  briefId: string;
  interviewId: string;
  candidateUserId: string;
  message: string;
}

export interface ReasonBody {
  reason?: string;
}

// --- Matches ------------------------------------------------------------------------------------

export const MATCH_STATUSES = ['active', 'completed', 'ended'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const MATCH_STATUS_LABELS: Readonly<Record<MatchStatus, string>> = {
  active: 'Active',
  completed: 'Completed',
  ended: 'Ended',
};

export const MATCH_END_REASONS = [
  'participant_ended',
  'sprint_rejected',
  'sprint_cancelled',
  'inactivity',
  /** The brief closed while the request was being accepted (race; Section 25). */
  'brief_closed',
  'blocked',
  'account_suspended',
  /** View-only: blocks and suspensions are never named to the other person (Section 21). */
  'unavailable',
] as const;
export type MatchEndReason = (typeof MATCH_END_REASONS)[number];

export const MATCH_END_REASON_LABELS: Readonly<Record<MatchEndReason, string>> = {
  participant_ended: 'Ended by a participant',
  sprint_rejected: 'The trial sprint proposal was rejected',
  sprint_cancelled: 'The trial sprint was cancelled',
  inactivity: 'No trial sprint was agreed within 30 days',
  brief_closed: 'The brief closed while the request was being accepted',
  blocked: 'This collaboration is no longer available',
  account_suspended: 'This collaboration is no longer available',
  unavailable: 'This collaboration is no longer available',
};

export const MATCH_ACTIONS = ['end', 'propose_sprint'] as const;
export type MatchAction = (typeof MATCH_ACTIONS)[number];

export interface MatchView {
  id: string;
  requestId: string;
  status: MatchStatus;
  viewerRole: 'founder' | 'candidate';
  briefId: string;
  briefTitle: string;
  terms: TermsSnapshot;
  founder: ParticipantSummary;
  candidate: ParticipantSummary;
  interviewId: string;
  startedAt: string;
  endedAt: string | null;
  endReason: MatchEndReason | null;
  endNote: string | null;
  sprint: SprintSummary | null;
  allowedActions: MatchAction[];
  unavailable: boolean;
  serverNow: string;
}

export interface EndMatchBody {
  reason: string;
}

// --- Sprints ------------------------------------------------------------------------------------

export const SPRINT_LIMITS = {
  titleMax: 100,
  scopeMin: 50,
  scopeMax: 2_000,
  itemsMin: 1,
  itemsMax: 5,
  itemMax: 300,
  hoursMin: 1,
  hoursMax: TRIAL_CAP_HOURS,
  /** Deadline must be after now and at most 14 days ahead at send and approve. */
  deadlineMaxMs: 14 * 24 * 3600_000,
  reviewWindowMs: 7 * 24 * 3600_000,
  acknowledgementWindowMs: 7 * 24 * 3600_000,
  noteMax: 2_000,
  reviewReasonMax: 500,
  reviewSummaryMax: 2_000,
  disagreementMax: 500,
} as const;

export const SPRINT_STATUSES = [
  'proposed',
  'awaiting_approval',
  'active',
  'submitted',
  'reviewed',
  'completed',
  'rejected',
  'cancelled',
] as const;
export type SprintStatus = (typeof SPRINT_STATUSES)[number];

export const TERMINAL_SPRINT_STATUSES: readonly SprintStatus[] = [
  'completed',
  'rejected',
  'cancelled',
];

export const SPRINT_STATUS_LABELS: Readonly<Record<SprintStatus, string>> = {
  proposed: 'Draft proposal',
  awaiting_approval: 'Waiting for approval',
  active: 'Active — work in progress',
  submitted: 'Submitted — waiting for review',
  reviewed: 'Reviewed — waiting for acknowledgements',
  completed: 'Completed trial',
  rejected: 'Proposal rejected',
  cancelled: 'Cancelled',
};

export const SPRINT_TERMINAL_REASONS = [
  'rejected',
  'participant_cancelled',
  'proposal_expired',
  'deadline_missed',
  'review_timeout',
  'acknowledgement_timeout',
  'match_ended',
  'blocked',
  'account_suspended',
  'completed',
  /** View-only: blocks and suspensions are never named to the other person (Section 21). */
  'unavailable',
] as const;
export type SprintTerminalReason = (typeof SPRINT_TERMINAL_REASONS)[number];

export const SPRINT_TERMINAL_REASON_LABELS: Readonly<Record<SprintTerminalReason, string>> = {
  rejected: 'The proposal was rejected',
  participant_cancelled: 'Cancelled by a participant',
  proposal_expired: 'The deadline passed before both approved',
  deadline_missed: 'The deadline passed without a submission',
  review_timeout: 'The founder did not review within 7 days',
  acknowledgement_timeout: 'The outcome was not acknowledged by both within 7 days',
  match_ended: 'The match ended',
  blocked: 'This collaboration is no longer available',
  account_suspended: 'This collaboration is no longer available',
  completed: 'Completed',
  unavailable: 'This collaboration is no longer available',
};

/** Blocks and suspensions are shown to participants only as "no longer available". */
export function publicReason<T extends string>(reason: T): T | 'unavailable' {
  return reason === 'blocked' || reason === 'account_suspended' ? 'unavailable' : reason;
}

export const SPRINT_ACTIONS = [
  'edit',
  'send',
  'approve',
  'reject',
  'cancel',
  'submit',
  'review',
  'acknowledge',
] as const;
export type SprintAction = (typeof SPRINT_ACTIONS)[number];

export const CRITERION_OUTCOMES = ['met', 'partially_met', 'not_met'] as const;
export type CriterionOutcome = (typeof CRITERION_OUTCOMES)[number];
export const CRITERION_OUTCOME_LABELS: Readonly<Record<CriterionOutcome, string>> = {
  met: 'Met',
  partially_met: 'Partially met',
  not_met: 'Not met',
};

/** Section 13 fixed notices. */
export const SPRINT_HOUR_CAP_NOTICE =
  'Stop at the agreed hour cap and discuss any unfinished work; do not silently extend the trial.';
export const ACKNOWLEDGEMENT_NOTICE =
  'Acknowledging records that you received the outcome. It is not agreement; add a note if you disagree.';
export const SUBMISSION_ATTESTATION =
  'The founder may view this link, and it contains no third-party secrets.';
export const MATCH_NOT_EMPLOYMENT_NOTICE =
  'A match is consent to collaborate on the displayed terms, not agreement to employment or equity.';

/** Proposal fields as entered (create / PATCH changes). Criteria ids are server-generated. */
export interface SprintProposalInput {
  title: string;
  scope: string;
  deliverables: string[];
  criteria: string[];
  expectedHours: number;
  /** ISO 8601 UTC. */
  deadline: string;
  compensation: CompensationTerms;
}

export interface SprintCriterion {
  id: string;
  text: string;
}

export interface SprintTerms {
  title: string;
  scope: string;
  deliverables: string[];
  criteria: SprintCriterion[];
  expectedHours: number;
  deadline: string;
  compensation: CompensationTerms;
  ipPolicyVersion: typeof VERSIONS.ipPolicy;
}

export interface SprintApprovalView {
  role: 'founder' | 'candidate';
  version: number;
  termsHash: string;
  approvedAt: string;
}

export interface SprintVersionView {
  version: number;
  terms: SprintTerms;
  termsHash: string;
  changedAt: string;
  changedBy: 'founder' | 'candidate';
}

export interface SprintSubmissionView {
  url: string;
  note: string;
  sharePermissionAcknowledged: true;
  submittedAt: string;
}

export interface CriterionResult {
  criterionId: string;
  outcome: CriterionOutcome;
  reason: string;
}

export interface SprintReviewView {
  version: 1;
  criteriaResults: CriterionResult[];
  overallOutcome: CriterionOutcome;
  summary: string;
  reviewedAt: string;
}

export interface SprintAcknowledgementView {
  role: 'founder' | 'candidate';
  reviewVersion: number;
  disagreementNote: string;
  at: string;
}

export interface SprintSummary {
  id: string;
  status: SprintStatus;
  version: number;
  title: string;
  deadline: string;
}

export interface SprintView {
  id: string;
  matchId: string;
  status: SprintStatus;
  viewerRole: 'founder' | 'candidate';
  proposerRole: 'founder' | 'candidate';
  version: number;
  termsHash: string;
  terms: SprintTerms;
  /** The brief's compensation: the minimum the sprint must keep (Section 13). */
  minimumCompensation: CompensationTerms;
  approvals: SprintApprovalView[];
  history: SprintVersionView[];
  createdAt: string;
  sentAt: string | null;
  startedAt: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  submission: SprintSubmissionView | null;
  review: SprintReviewView | null;
  acknowledgements: SprintAcknowledgementView[];
  terminalReason: SprintTerminalReason | null;
  terminalNote: string | null;
  /** Server-computed due dates; authoritative deadlines are enforced on the server. */
  reviewDueAt: string | null;
  acknowledgementDueAt: string | null;
  timeline: TimelineEntry[];
  allowedActions: SprintAction[];
  founder: ParticipantSummary;
  candidate: ParticipantSummary;
  serverNow: string;
}

export interface SprintPatchBody {
  expectedVersion: number;
  changes: Partial<SprintProposalInput>;
}
export interface SprintSendBody {
  expectedVersion: number;
  acknowledgeUnpaid?: boolean;
}
export interface SprintApproveBody {
  expectedVersion: number;
  termsHash: string;
  acknowledgeUnpaid?: boolean;
}
export interface SprintRejectBody {
  expectedVersion: number;
  reason: string;
}
export interface SprintSubmitBody {
  url: string;
  note?: string;
  sharePermissionAcknowledged: true;
}
export interface SprintReviewBody {
  criteriaResults: CriterionResult[];
  summary?: string;
}
export interface SprintAcknowledgeBody {
  reviewVersion: number;
  disagreementNote?: string;
}

// --- Pure rules (shared by server validation and the UI) -----------------------------------------

export interface FieldIssue {
  field: string;
  message: string;
}

/** Section 13: overall outcome is met only if every criterion is met, not_met if all are not_met. */
export function overallOutcome(
  results: readonly { outcome: CriterionOutcome }[],
): CriterionOutcome {
  if (results.length > 0 && results.every((r) => r.outcome === 'met')) return 'met';
  if (results.length > 0 && results.every((r) => r.outcome === 'not_met')) return 'not_met';
  return 'partially_met';
}

export function isNonMonetary(c: CompensationTerms): boolean {
  return c.type !== 'paid';
}

const COMP_RANK: Readonly<Record<CompensationType, number>> = {
  unpaid: 0,
  credit_reference: 1,
  paid: 2,
};

/**
 * Section 13 brief-versus-sprint rule: keep the same type and details, or improve
 * credit_reference/unpaid to paid. For paid briefs the amount cannot decrease and paymentDueDays
 * cannot increase; currency stays INR. Returns the problems (empty = allowed).
 */
export function compensationIssues(
  minimum: CompensationTerms,
  proposed: CompensationTerms,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (proposed.type === 'paid') {
    if (!Number.isSafeInteger(proposed.amountMinor) || proposed.amountMinor < 1)
      issues.push({ field: 'compensation.amountMinor', message: 'Enter the amount in INR.' });
    if (proposed.currency !== CURRENCY)
      issues.push({ field: 'compensation.currency', message: 'Currency must be INR.' });
    if (
      !Number.isInteger(proposed.paymentDueDays) ||
      proposed.paymentDueDays < BRIEF_LIMITS.paymentDueDaysMin ||
      proposed.paymentDueDays > BRIEF_LIMITS.paymentDueDaysMax
    )
      issues.push({
        field: 'compensation.paymentDueDays',
        message: `Set payment due ${BRIEF_LIMITS.paymentDueDaysMin}-${BRIEF_LIMITS.paymentDueDaysMax} days after submission.`,
      });
    const note = chars(proposed.methodNote ?? '');
    if (note < 1 || note > BRIEF_LIMITS.methodNoteMax)
      issues.push({ field: 'compensation.methodNote', message: 'Describe how you will pay.' });
  } else if (proposed.type === 'credit_reference') {
    const n = chars(proposed.benefitDescription ?? '');
    if (n < BRIEF_LIMITS.benefitDescriptionMin || n > BRIEF_LIMITS.benefitDescriptionMax)
      issues.push({
        field: 'compensation.benefitDescription',
        message: `Describe the credit or reference in ${BRIEF_LIMITS.benefitDescriptionMin}-${BRIEF_LIMITS.benefitDescriptionMax} characters.`,
      });
  }
  if (issues.length > 0) return issues;

  if (proposed.type !== minimum.type && proposed.type !== 'paid') {
    // Only "same type" or an improvement to paid is allowed (Section 13).
    return [
      {
        field: 'compensation.type',
        message:
          COMP_RANK[proposed.type] < COMP_RANK[minimum.type]
            ? 'The sprint cannot offer less than the brief promised.'
            : 'Keep the brief’s compensation type, or offer payment instead.',
      },
    ];
  }
  if (minimum.type === 'paid' && proposed.type === 'paid') {
    if (proposed.amountMinor < minimum.amountMinor)
      issues.push({
        field: 'compensation.amountMinor',
        message: 'The amount cannot be lower than the brief’s.',
      });
    if (proposed.paymentDueDays > minimum.paymentDueDays)
      issues.push({
        field: 'compensation.paymentDueDays',
        message: 'Payment cannot be due later than the brief promised.',
      });
    // Other paid-term changes need a new brief (Section 13).
    if (proposed.methodNote.trim() !== minimum.methodNote.trim())
      issues.push({
        field: 'compensation.methodNote',
        message: 'Keep the brief’s payment method; other paid-term changes need a new brief.',
      });
  }
  if (
    minimum.type === 'credit_reference' &&
    proposed.type === 'credit_reference' &&
    proposed.benefitDescription !== minimum.benefitDescription
  ) {
    issues.push({
      field: 'compensation.benefitDescription',
      message: 'Keep the brief’s credit/reference terms, or offer payment instead.',
    });
  }
  return issues;
}

/**
 * Section 13 deadline rule at send and approve: after now and at most 14 days ahead. Returns an
 * issue or null.
 */
export function deadlineIssue(deadlineIso: string, now: Date): FieldIssue | null {
  const t = Date.parse(deadlineIso);
  if (!Number.isFinite(t) || !/Z$|[+-]\d{2}:\d{2}$/.test(deadlineIso))
    return { field: 'deadline', message: 'Enter a valid date and time.' };
  if (t <= now.getTime())
    return { field: 'deadline', message: 'The deadline must be in the future.' };
  if (t > now.getTime() + SPRINT_LIMITS.deadlineMaxMs)
    return { field: 'deadline', message: 'The deadline must be within 14 days.' };
  return null;
}

/** Validates proposal fields (lengths, counts, hours, compensation floor, deadline window). */
export function sprintProposalIssues(
  input: SprintProposalInput,
  minimum: CompensationTerms,
  now: Date,
): FieldIssue[] {
  const L = SPRINT_LIMITS;
  const issues: FieldIssue[] = [];
  const title = chars(input.title.trim());
  if (title < 1 || title > L.titleMax)
    issues.push({ field: 'title', message: `Use 1-${L.titleMax} characters.` });
  const scope = chars(input.scope.trim());
  if (scope < L.scopeMin || scope > L.scopeMax)
    issues.push({
      field: 'scope',
      message: `Describe the scope in ${L.scopeMin}-${L.scopeMax} characters.`,
    });
  for (const key of ['deliverables', 'criteria'] as const) {
    const list = input[key];
    if (list.length < L.itemsMin || list.length > L.itemsMax)
      issues.push({ field: key, message: `List ${L.itemsMin}-${L.itemsMax} items.` });
    list.forEach((item, i) => {
      const n = chars(item.trim());
      if (n < 1 || n > L.itemMax)
        issues.push({ field: `${key}.${i}`, message: `Use 1-${L.itemMax} characters.` });
    });
  }
  if (
    !Number.isInteger(input.expectedHours) ||
    input.expectedHours < L.hoursMin ||
    input.expectedHours > L.hoursMax
  )
    issues.push({
      field: 'expectedHours',
      message: `Expected effort is a whole number of total hours, ${L.hoursMin}-${L.hoursMax}.`,
    });
  const d = deadlineIssue(input.deadline, now);
  if (d) issues.push(d);
  issues.push(...compensationIssues(minimum, input.compensation));
  return issues;
}

export type SubmissionUrlCheck = { ok: true; url: string } | { ok: false; message: string };

/** Section 23 rules for the single sprint deliverable link (never fetched by the server). */
export function checkSubmissionUrl(raw: string): SubmissionUrlCheck {
  const r = checkHttpsUrl(raw.trim());
  if (r.ok) return r;
  const messages: Record<typeof r.reason, string> = {
    too_long: 'Use at most 2,048 characters.',
    invalid: 'Enter a full link starting with https://.',
    not_https: 'Only https:// links are accepted.',
    credentials: 'Remove the username or password from the link.',
    fragment: 'Remove the #fragment from the link.',
    port: 'Links with a custom port are not accepted.',
    local_host: 'Use a public host name (no localhost or .local).',
    ip_literal: 'Use a host name, not an IP address.',
  };
  return { ok: false, message: messages[r.reason] };
}
