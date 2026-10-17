import type { ROLE_KEY } from './constants.js';
import { type SkillId } from './constants.js';

/**
 * Data contracts for the future AI interview system (Phase 4 preparation only — nothing here is
 * executed yet). Planned flow:
 *
 *   founder invitation -> candidate acceptance (consents below) -> live interview room
 *   (candidate webcam + AI avatar) -> spoken introduction -> resume-based technical questions ->
 *   spoken answers -> speech-to-text -> adaptive follow-up -> separate analyses -> final report.
 *
 * Rules fixed now so later phases cannot drift:
 *  - Question generation receives redacted resume text and skill data only: no user IDs, names,
 *    email, phone, links or the confidential brief problem/solution (Section 23).
 *  - Technical correctness is the only category that can produce a technical score. Language
 *    feedback, audio characteristics and video observations are reported separately and have no
 *    effect on technical scores.
 *  - Audio/video outputs are measurable signals and observable events only. They are never
 *    evidence of cheating, nervousness, confidence or dishonesty.
 *  - Every AI model used later must be free, open-source and preferably self-hostable, with its
 *    licence and commercial-use terms verified (docs/architecture/AI_PROVIDER_ARCHITECTURE.md).
 */

export const INTERVIEW_CONTRACT_VERSION = 'ai-interview-contract-v1' as const;

// --- Resume reference -------------------------------------------------------------------------

/**
 * Identifies the exact resume text an interview used. Future InterviewSession records store this
 * at acceptance (alongside the profile snapshot), so a later replacement or deletion of the
 * resume never rewrites what an interview was based on.
 */
export interface ResumeRef {
  resumeVersion: number;
  textSha256: string;
  extractorVersion: string;
}

/** How a future interview session is bound to resume input. */
export type InterviewResumeBinding =
  | { mode: 'resume_based'; resumeRef: ResumeRef }
  /** No usable resume: questions come from profile skills and projects only. */
  | { mode: 'profile_only'; resumeRef: null; reason: 'no_resume' | 'no_text' | 'consent_missing' };

// --- Question generation (user's fine-tuned API, Dev 2) ----------------------------------------

export const QUESTION_GENERATION_LIMITS = {
  resumeTextMaxChars: 30_000,
  questionCountMin: 1,
  questionCountMax: 10,
  questionMaxChars: 600,
  evidenceQuoteMinChars: 20,
  evidenceQuoteMaxChars: 300,
  answerMaxChars: 4_000,
} as const;

export interface ResumeQuestionGenerationInput {
  contractVersion: typeof INTERVIEW_CONTRACT_VERSION;
  roleKey: typeof ROLE_KEY;
  language: 'en';
  resume: {
    ref: ResumeRef;
    /** Contact details removed (redactContactDetails); delimited as data, never instructions. */
    redactedText: string;
    truncated: boolean;
  };
  /** Self-reported candidate profile data (no names or links). */
  profile: {
    skills: Array<{ skillId: SkillId; level: number }>;
    projects: Array<{ title: string; description: string; skillTags: SkillId[] }>;
  };
  /** Role requirements only — never the brief's confidential problem/solution. */
  brief: {
    requiredSkills: Array<{ skillId: SkillId; level: number; importance: number }>;
  };
  constraints: {
    questionCount: number;
    maxQuestionChars: number;
  };
}

export interface GeneratedQuestion {
  /** Provider-local id, e.g. "Q1". The backend assigns stored ids. */
  id: string;
  prompt: string;
  targetSkills: SkillId[];
  /**
   * Exact substring of the redacted resume text the question is based on. The backend rejects
   * questions whose evidence is not an exact substring (Section 23 evidence check).
   */
  resumeEvidence: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
}

export interface ResumeQuestionGenerationOutput {
  questions: GeneratedQuestion[];
}

// --- Adaptive follow-up (user's fine-tuned API, Dev 2) -----------------------------------------

/** Section 23: a follow-up is generated from one question and its one answer. */
export interface FollowUpGenerationInput {
  contractVersion: typeof INTERVIEW_CONTRACT_VERSION;
  roleKey: typeof ROLE_KEY;
  language: 'en';
  question: { id: string; prompt: string; targetSkills: SkillId[] };
  /** Final speech-to-text transcript (or typed answer), delimited as data. */
  answerText: string;
  /** The resume evidence the question was based on, if any. */
  resumeEvidence: string | null;
}

export interface FollowUpGenerationOutput {
  /** Null when no follow-up is warranted. */
  followUp: { prompt: string; targetSkills: SkillId[] } | null;
}

// --- Analysis categories (kept separate; only technical can score) ----------------------------

export const ANALYSIS_CATEGORIES = [
  'technical_correctness',
  'language_feedback',
  'audio_characteristics',
  'video_observations',
] as const;
export type AnalysisCategory = (typeof ANALYSIS_CATEGORIES)[number];

/** Categories that may never influence technical scores. */
export const NON_SCORING_CATEGORIES: ReadonlySet<AnalysisCategory> = new Set([
  'language_feedback',
  'audio_characteristics',
  'video_observations',
]);

export const OBSERVATION_LIMITATIONS_NOTICE =
  'Audio and video observations describe measurable signals and visible events only. They are ' +
  'not evidence of cheating, nervousness, confidence or dishonesty, and they never change ' +
  'technical scores.';

interface AnalysisProvenance {
  providerId: string;
  model: string;
  adapterVersion: string;
  analysedAt: string;
}

/** Correctness of the technical content of one answer — the only scoring category. */
export interface TechnicalCorrectnessAnalysis extends AnalysisProvenance {
  category: 'technical_correctness';
  questionId: string;
  /** Dimension scores defined by the rubric version; totals are computed by the backend. */
  dimensions: Record<string, number>;
  strengths: string[];
  gaps: string[];
  uncertainties: string[];
  rubricVersion: string;
}

/** Grammar, clarity and communication feedback — qualitative, never a technical score. */
export interface LanguageFeedbackAnalysis extends AnalysisProvenance {
  category: 'language_feedback';
  questionId: string;
  detectedLanguage: string;
  comments: string[];
  affectsTechnicalScore: false;
}

/** Deterministic measurements of the audio; no interpretation of personality or state. */
export interface AudioCharacteristicsAnalysis extends AnalysisProvenance {
  category: 'audio_characteristics';
  questionId: string;
  measurements: {
    speechDurationMs: number;
    wordsPerMinute: number | null;
    pauseCount: number;
    longestPauseMs: number;
    /** Share of the answer window without detected speech, 0-1. */
    silenceRatio: number;
  };
  affectsTechnicalScore: false;
}

/** Same vocabulary as the AI module's observable video events. */
export const OBSERVABLE_VIDEO_EVENT_TYPES = [
  'face_visible',
  'face_not_visible',
  'multiple_faces',
  'gaze_off_screen',
  'camera_interrupted',
] as const;
export type ObservableVideoEventType = (typeof OBSERVABLE_VIDEO_EVENT_TYPES)[number];

/** Time-stamped observable events; never labels such as "cheating" or "nervous". */
export interface VideoObservationsAnalysis extends AnalysisProvenance {
  category: 'video_observations';
  events: Array<{ type: ObservableVideoEventType; startMs: number; endMs: number }>;
  affectsTechnicalScore: false;
}

export type InterviewAnalysis =
  | TechnicalCorrectnessAnalysis
  | LanguageFeedbackAnalysis
  | AudioCharacteristicsAnalysis
  | VideoObservationsAnalysis;

// --- Media and analysis consent ---------------------------------------------------------------

export const INTERVIEW_MEDIA_POLICY_VERSION = 'interview-media-v1' as const;

export const INTERVIEW_MEDIA_CONSENT_ITEMS = [
  'webcam',
  'microphone',
  'recording',
  'technical_analysis',
  'language_analysis',
  'audio_analysis',
  'video_analysis',
] as const;
export type InterviewMediaConsentItem = (typeof INTERVIEW_MEDIA_CONSENT_ITEMS)[number];

/**
 * Required for the live interview to start: camera and microphone access for the live room and
 * technical analysis of the transcribed answers. Recording and the other analyses are optional;
 * declining them skips that analysis and is never penalised.
 */
export const REQUIRED_MEDIA_CONSENTS: readonly InterviewMediaConsentItem[] = [
  'webcam',
  'microphone',
  'technical_analysis',
];

export interface InterviewMediaConsent {
  policyVersion: typeof INTERVIEW_MEDIA_POLICY_VERSION;
  items: Record<InterviewMediaConsentItem, boolean>;
  grantedAt: string;
}

export function missingRequiredMediaConsents(
  consent: Pick<InterviewMediaConsent, 'items'> | null,
): InterviewMediaConsentItem[] {
  return REQUIRED_MEDIA_CONSENTS.filter((item) => !consent?.items[item]);
}

/** Which analyses may run under a consent; an item without consent is skipped entirely. */
export function permittedAnalyses(
  consent: Pick<InterviewMediaConsent, 'items'> | null,
): AnalysisCategory[] {
  if (!consent) return [];
  const out: AnalysisCategory[] = [];
  if (consent.items.technical_analysis) out.push('technical_correctness');
  if (consent.items.language_analysis) out.push('language_feedback');
  if (consent.items.audio_analysis && consent.items.microphone) out.push('audio_characteristics');
  if (consent.items.video_analysis && consent.items.webcam) out.push('video_observations');
  return out;
}

/**
 * Technical score input filter: only technical-correctness analyses are accepted. Any other
 * category passed here is a programming error, so it throws instead of being silently mixed in.
 */
export function technicalScoringInputs(
  analyses: readonly InterviewAnalysis[],
): TechnicalCorrectnessAnalysis[] {
  return analyses.filter((a): a is TechnicalCorrectnessAnalysis => {
    if (a.category === 'technical_correctness') return true;
    if (NON_SCORING_CATEGORIES.has(a.category)) return false;
    throw new Error(`Unknown analysis category: ${String((a as { category: unknown }).category)}`);
  });
}
