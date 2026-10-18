import type {
  CompensationTerms,
  CriterionOutcome,
  MatchEndReason,
  MatchRequestStatus,
  MatchStatus,
  RequestWithdrawReason,
  SprintStatus,
  SprintTerminalReason,
  SprintTerms,
  TermsSnapshot,
} from '@cofoundry/shared';

/**
 * Stored shapes of the collaboration collections (Contract Section 16). Every record carries a
 * `rev` counter: each change is one conditional replace on (id, rev), inside a transaction when
 * two records change together. Timelines hold display events only (no message or note text).
 */

export type Actor = 'founder' | 'candidate' | 'system' | 'moderator';

export interface TimelineRecord {
  at: Date;
  event: string;
  actor: Actor;
}

/** Minimal frozen profile facts; never contact details. */
export interface ProfileSnapshot {
  userId: string;
  displayName: string;
  revision: number | null;
  headline: string | null;
}

export interface MatchRequestRecord {
  id: string;
  rev: number;
  briefId: string;
  candidateUserId: string;
  founderUserId: string;
  interviewId: string;
  reportVersion: number;
  /** Report facts frozen at request time (the report itself stays in the interview). */
  reportScore: number | null;
  reportEvidenceLevel: string | null;
  message: string;
  termsSnapshot: TermsSnapshot;
  profileSnapshots: { candidate: ProfileSnapshot; founder: ProfileSnapshot };
  status: MatchRequestStatus;
  expiresAt: Date;
  respondedAt: Date | null;
  responseReason: string | null;
  withdrawReason: RequestWithdrawReason | null;
  matchId: string | null;
  timeline: TimelineRecord[];
  createdAt: Date;
  updatedAt: Date;
}

export interface MatchRecord {
  id: string;
  rev: number;
  requestId: string;
  briefId: string;
  founderUserId: string;
  candidateUserId: string;
  interviewId: string;
  status: MatchStatus;
  termsSnapshot: TermsSnapshot;
  startedAt: Date;
  endedAt: Date | null;
  endReason: MatchEndReason | null;
  /** Free-text reason given by the participant who ended it (visible to both participants). */
  endNote: string | null;
  sprintId: string | null;
  timeline: TimelineRecord[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalRecord {
  userId: string;
  version: number;
  termsHash: string;
  approvedAt: Date;
}

export interface SprintVersionRecord {
  version: number;
  terms: SprintTerms;
  termsHash: string;
  changedAt: Date;
  changedBy: string;
}

export interface SubmissionRecord {
  url: string;
  note: string;
  sharePermissionAcknowledged: true;
  submittedAt: Date;
}

export interface ReviewRecord {
  version: 1;
  criteriaResults: Array<{ criterionId: string; outcome: CriterionOutcome; reason: string }>;
  overallOutcome: CriterionOutcome;
  summary: string;
  reviewedAt: Date;
}

export interface AcknowledgementRecord {
  userId: string;
  reviewVersion: number;
  disagreementNote: string;
  at: Date;
}

export interface TrialSprintRecord {
  id: string;
  rev: number;
  matchId: string;
  founderUserId: string;
  candidateUserId: string;
  proposerUserId: string;
  /** Always the candidate (Section 12). */
  contributorUserId: string;
  /** Always the founder (Section 12). */
  reviewerUserId: string;
  version: number;
  termsHash: string;
  terms: SprintTerms;
  /** The brief compensation copied from the match: the minimum promise. */
  minimumCompensation: CompensationTerms;
  approvals: ApprovalRecord[];
  history: SprintVersionRecord[];
  status: SprintStatus;
  sentAt: Date | null;
  startedAt: Date | null;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  submission: SubmissionRecord | null;
  review: ReviewRecord | null;
  acknowledgements: AcknowledgementRecord[];
  terminalReason: SprintTerminalReason | null;
  terminalNote: string | null;
  timeline: TimelineRecord[];
  createdAt: Date;
  updatedAt: Date;
}
