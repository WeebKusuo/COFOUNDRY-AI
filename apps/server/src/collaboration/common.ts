import { UNAVAILABLE_NOTICE, type ParticipantSummary, type TimelineEntry } from '@cofoundry/shared';
import type { UserRecord } from '../auth/store.js';
import { AppError } from '../http/errors.js';
import type { Actor, TimelineRecord } from './records.js';

export const notFound = () => new AppError('NOT_FOUND', 'The requested resource was not found.');
export const invalid = (message: string) => new AppError('INVALID_STATE', message);
export const forbidden = (message: string) => new AppError('FORBIDDEN', message);
export const unavailable = () => invalid(UNAVAILABLE_NOTICE);

export function participantRole(
  rec: { founderUserId: string; candidateUserId: string },
  user: UserRecord,
): 'founder' | 'candidate' | null {
  if (rec.founderUserId === user.id) return 'founder';
  if (rec.candidateUserId === user.id) return 'candidate';
  return null;
}

export function summaryOf(user: UserRecord | undefined, fallbackId: string): ParticipantSummary {
  return {
    userId: fallbackId,
    displayName: user?.displayName ?? 'Former user',
    demoAccount: user?.accountMode === 'demo',
  };
}

export function withEvent<T extends { timeline: TimelineRecord[] }>(
  rec: T,
  event: string,
  actor: Actor,
  at: Date,
): T {
  return { ...rec, timeline: [...rec.timeline, { at, event, actor }] };
}

export function timelineView(t: readonly TimelineRecord[]): TimelineEntry[] {
  return t.map((e) => ({ at: e.at.toISOString(), event: e.event, actor: e.actor }));
}

export const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Both accounts must be active for any new interaction (Sections 11, 21). */
export function bothActive(a: UserRecord | null | undefined, b: UserRecord | null | undefined) {
  return !!a && !!b && a.status === 'active' && b.status === 'active';
}

export interface InterviewFacts {
  interviewId: string;
  founderUserId: string;
  candidateUserId: string;
  briefId: string;
  /** Submitted and successfully evaluated, with a stored report. */
  evaluated: boolean;
  consentActive: boolean;
  quarantined: boolean;
  /** A block cut the founder's access to this assessment. */
  blocked: boolean;
  reportVersion: number | null;
  overallScore: number | null;
  evidenceLevel: string | null;
}

/** What the collaboration services need from interviews (implemented by InterviewService). */
export interface InterviewFactsPort {
  collaborationFacts(interviewId: string): Promise<InterviewFacts | null>;
}

/** Open correction cases on an interview report (implemented by the safety service). */
export interface ReportSafetyPort {
  openCorrections(interviewId: string): Promise<number>;
}

export const NO_REPORT_SAFETY: ReportSafetyPort = { openCorrections: async () => 0 };
