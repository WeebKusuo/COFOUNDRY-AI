/**
 * Trust and safety contracts (Phase 14; Implementation Contract v3.0 Sections 16, 21, 24).
 *
 * Blocks are directed records; either direction blocks interaction between the pair. Reports
 * and corrections open a SafetyCase that only its reporter and the assigned moderator can read.
 * Moderators claim a case, read the minimum evidence (audited) and resolve it; they cannot edit
 * answers, numeric scores or consent history. Nothing here is decided automatically or by AI.
 */

export const SAFETY_LIMITS = {
  textMin: 10,
  textMax: 2_000,
  casesPerUserPerDay: 10,
  resolutionMin: 1,
  resolutionMax: 2_000,
  noteMax: 2_000,
  correctionMax: 2_000,
  /** Dispute holds are reviewed every 30 days (Section 24). */
  holdReviewMs: 30 * 24 * 3600_000,
} as const;

/** Shown to the other person instead of any reason (Section 21). */
export const UNAVAILABLE_NOTICE = 'This collaboration is no longer available.';

export interface BlockView {
  targetUserId: string;
  displayName: string;
  createdAt: string;
}

export interface CreateBlockBody {
  targetUserId: string;
}

export const CASE_KINDS = ['report', 'correction'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

export const REPORT_TARGET_TYPES = ['user', 'profile', 'brief', 'report', 'sprint'] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

export const CORRECTION_TARGET_TYPES = ['profile', 'report'] as const;
export type CorrectionTargetType = (typeof CORRECTION_TARGET_TYPES)[number];

export const CASE_TARGET_TYPE_LABELS: Readonly<Record<ReportTargetType, string>> = {
  user: 'Person',
  profile: 'Profile',
  brief: 'Startup brief',
  report: 'Interview report',
  sprint: 'Trial sprint',
};

export const REPORT_CATEGORIES = [
  'harassment_or_abuse',
  'inappropriate_content',
  'misrepresentation',
  'spam_or_scam',
  'privacy_violation',
  'sprint_dispute',
  'assessment_error',
  'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const REPORT_CATEGORY_LABELS: Readonly<Record<ReportCategory, string>> = {
  harassment_or_abuse: 'Harassment or abuse',
  inappropriate_content: 'Inappropriate content',
  misrepresentation: 'Misrepresentation',
  spam_or_scam: 'Spam or scam',
  privacy_violation: 'Privacy violation',
  sprint_dispute: 'Trial sprint dispute',
  assessment_error: 'Incorrect assessment evidence',
  other: 'Other',
};

export const CASE_STATUSES = ['open', 'in_review', 'resolved', 'dismissed'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_STATUS_LABELS: Readonly<Record<CaseStatus, string>> = {
  open: 'Open — waiting for a moderator',
  in_review: 'In review',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

export interface CreateReportBody {
  targetType: ReportTargetType;
  targetId: string;
  category: ReportCategory;
  text: string;
}

export interface CreateCorrectionBody {
  targetType: CorrectionTargetType;
  targetId: string;
  text: string;
}

/** What the reporter sees: their own words, status and the moderator's resolution. */
export interface CaseReporterView {
  id: string;
  kind: CaseKind;
  category: ReportCategory | null;
  targetType: ReportTargetType;
  targetId: string;
  text: string;
  status: CaseStatus;
  /** A user claim, not a verified finding, until a moderator resolves it. */
  verified: boolean;
  resolutionText: string | null;
  displayCorrection: string | null;
  hold: { reason: string; scope: string; reviewAt: string } | null;
  openedAt: string;
  resolvedAt: string | null;
  /** True when this submission was linked to an existing open case instead of a new one. */
  linked?: boolean;
}

export interface CaseSummaryView {
  id: string;
  kind: CaseKind;
  category: ReportCategory | null;
  targetType: ReportTargetType;
  status: CaseStatus;
  assignedToMe: boolean;
  assigned: boolean;
  openedAt: string;
  resolvedAt: string | null;
}

export interface CaseNoteView {
  text: string;
  at: string;
  /** Moderators are attributed by role, not personal identity, in exported views. */
  by: 'moderator';
}

/** Assigned moderator only: case text, minimum target evidence and participant ids. */
export interface CaseContextView {
  case: CaseSummaryView & {
    text: string;
    reporterUserId: string;
    targetUserId: string | null;
    targetId: string;
    resolutionText: string | null;
    displayCorrection: string | null;
    hold: {
      reason: string;
      scope: string;
      setAt: string;
      reviewAt: string;
      releasedAt: string | null;
    } | null;
    notes: CaseNoteView[];
    quarantinedReport: boolean;
    suspendedTarget: boolean;
  };
  participants: Array<{ userId: string; displayName: string; role: string; status: string }>;
  /** Minimal target evidence; structure depends on targetType. */
  evidence: { label: string; value: string }[];
  /** Related cases count for context; never used to infer guilt. */
  relatedOpenCases: number;
}

export interface ResolveCaseBody {
  decision: 'resolved' | 'dismissed';
  resolutionText: string;
  displayCorrection?: string;
  quarantineReport: boolean;
  suspendTarget: boolean;
}

export interface CaseNoteBody {
  text: string;
}

/** Corrections attached to an interview report (both participants see them). */
export interface ReportCorrectionView {
  caseId: string;
  text: string;
  at: string;
  by: 'CoFoundry moderator';
}
