import {
  looksLikePromptInjection,
  redactForAi,
  resumeReadinessMessage,
  type ResumeReadiness,
  type ResumeRef,
} from '@cofoundry/shared';
import type { ResumeService } from '../resumes/service.js';

/**
 * Resume preparation for the interview (Phase 7). Uses the candidate's uploaded English resume
 * from Phase 4 — never the PDF, only its extracted text after contact-detail redaction
 * (readForInterviewProcessing) plus best-effort removal of names, credentials and government ids
 * (redactForAi). Without a usable resume the interview cannot start: there is no silent fallback
 * to generic profile questions.
 */

/** Bounded so prompts stay within free-tier token budgets (about 3,000 tokens). */
export const RESUME_TEXT_FOR_AI_MAX = 12_000;

export type PreparedResume =
  | {
      ready: true;
      ref: ResumeRef;
      text: string;
      truncated: boolean;
      injectionSuspected: boolean;
    }
  | { ready: false; reason: 'no_resume' | 'no_text' | 'consent_missing' };

export async function prepareResumeForInterview(
  resumes: ResumeService,
  candidateUserId: string,
  knownNames: readonly string[],
): Promise<PreparedResume> {
  const result = await resumes.readForInterviewProcessing(candidateUserId);
  if (!result.ready) {
    const reason =
      result.reason === 'no_text' || result.reason === 'consent_missing'
        ? result.reason
        : 'no_resume';
    return { ready: false, reason };
  }
  const redacted = redactForAi(result.material.redactedText, { knownNames }).text;
  const chars = Array.from(redacted);
  return {
    ready: true,
    ref: { ...result.material.ref },
    text: chars.slice(0, RESUME_TEXT_FOR_AI_MAX).join(''),
    truncated: result.material.truncated || chars.length > RESUME_TEXT_FOR_AI_MAX,
    injectionSuspected: looksLikePromptInjection(redacted),
  };
}

export function readinessOf(prepared: PreparedResume): ResumeReadiness {
  return prepared.ready
    ? { ready: true, resumeVersion: prepared.ref.resumeVersion }
    : { ready: false, reason: prepared.reason, message: resumeReadinessMessage(prepared.reason) };
}
