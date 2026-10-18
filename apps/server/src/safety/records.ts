import type { CaseKind, CaseStatus, ReportCategory, ReportTargetType } from '@cofoundry/shared';

/** Stored shapes for Phase 14 (Contract Section 16): Block, SafetyCase, AuditEvent. */

export interface BlockRecord {
  id: string;
  blockerUserId: string;
  blockedUserId: string;
  createdAt: Date;
}

export interface CaseHoldRecord {
  reason: string;
  scope: ReportTargetType;
  setAt: Date;
  reviewAt: Date;
  releasedAt: Date | null;
}

export interface CaseNoteRecord {
  text: string;
  at: Date;
  moderatorId: string;
}

export interface SafetyCaseRecord {
  id: string;
  rev: number;
  kind: CaseKind;
  category: ReportCategory | null;
  reporterUserId: string;
  targetUserId: string | null;
  targetType: ReportTargetType;
  targetId: string;
  text: string;
  status: CaseStatus;
  assignedModeratorId: string | null;
  resolutionText: string | null;
  /** Section 16 correctionOverlay: corrected display text only, attributed to a moderator. */
  correctionOverlay: { text: string; moderatorId: string; at: Date } | null;
  quarantinedReport: boolean;
  suspendedTarget: boolean;
  hold: CaseHoldRecord | null;
  notes: CaseNoteRecord[];
  openedAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Section 16: actor pseudonymous (user id only), no content, contact or answer fields. */
export interface AuditEventRecord {
  id: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  requestId: string | null;
  time: Date;
  metadata: Record<string, string | number | boolean | null>;
}
