import type { BriefPreview, StartupBriefData } from './brief.js';
import type { SkillId } from './constants.js';

/**
 * AI technical interview contracts (Phases 7-10). This specification supersedes the fixed-anchor
 * text interview of Implementation Contract v3.0 Sections 07-09 and the Phase 4 draft contracts.
 *
 *   founder invitation -> candidate acceptance (consents) -> readiness check (microphone, voice,
 *   resume) -> spoken introduction -> adaptive resume-based questions, answered by voice
 *   (transcribed) or typing -> short coding/debugging task -> durable evaluation -> report.
 *
 * Fixed rules:
 *  - NO video analysis. No facial recognition, eye tracking, posture, emotion, nervousness,
 *    confidence or cheating inference from webcam, video or audio. The optional camera self-view
 *    is rendered locally in the candidate's browser only: never required, recorded, uploaded,
 *    sent anywhere or analysed.
 *  - Raw answer audio is transcribed and discarded; it is never stored.
 *  - Technical, coding and communication results are separate dimensions. Communication never
 *    changes technical or coding scores; accent, fluency and transcription errors are not
 *    penalised.
 *  - All aggregate scores are computed by the backend from the documented rubric
 *    (packages/shared/src/rubric.ts); models return bounded per-dimension judgments with evidence.
 *  - Reports support human review; they never reject a candidate automatically.
 */

export const INTERVIEW_CONTRACT_VERSION = 'ai-interview-contract-v2' as const;

/**
 * Identifies the exact resume text an interview used (Phase 4). Stored on the session at start,
 * so a later replacement or deletion of the resume never rewrites what the interview was based on.
 */
export interface ResumeRef {
  resumeVersion: number;
  textSha256: string;
  extractorVersion: string;
}

/** Server-enforced limits (Phase 7/8). Time values are seconds unless named otherwise. */
export const INTERVIEW_LIMITS = {
  invitationTtlMs: 7 * 24 * 60 * 60 * 1000,
  invitationsPerFounderPerDay: 20,
  /** Spoken/typed conversation stage. */
  conversationSeconds: 20 * 60,
  /** Coding stage. */
  codingSeconds: 20 * 60,
  /** From start, including generation and reconnect time; never extended. */
  globalSeconds: 45 * 60,
  maxQuestions: 10,
  /** The conversation may only end early once this many questions were answered. */
  minQuestions: 6,
  /** Consecutive follow-ups on one topic before the interviewer must change topic. */
  maxFollowUpDepth: 2,
  questionMaxChars: 600,
  answerMaxChars: 4_000,
  audioMaxBytes: 4 * 1024 * 1024,
  audioMaxSeconds: 180,
  /** A candidate may re-record an answer this many times before submitting. */
  maxRecordingsPerTurn: 3,
  reasonMaxChars: 500,
  codeMaxChars: 20_000,
  explanationMaxChars: 2_000,
  codeRunsPerSession: 30,
  /** Interval of the coding-round autosave (code and explanation). */
  codeAutosaveMs: 10_000,
  /** Manual evaluation retries after the automatic budget is exhausted. */
  manualEvaluationRetries: 2,
  /** Seconds between client heartbeats; a client that misses three is shown as disconnected. */
  heartbeatSeconds: 15,
} as const;

/** Spoken by the AI interviewer at the start of every interview (fixed text, not generated). */
export const INTERVIEW_INTRO_TEXT =
  "Hello! I'm your AI interviewer. I'll be conducting your initial technical interview based on " +
  "your resume, projects and technical experience. We'll also complete a short practical coding " +
  'assessment.';

export const VOICE_TEST_TEXT =
  'This is a voice check. If you can hear this clearly, your audio output is working.';

// --- Statuses and actions ---------------------------------------------------------------------

export const INTERVIEW_STATUSES = [
  'invited',
  'accepted',
  'in_progress',
  'coding',
  'submitted',
  'declined',
  'expired',
  'cancelled',
] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

export const TERMINAL_PRE_SUBMIT_STATUSES: ReadonlySet<InterviewStatus> = new Set([
  'declined',
  'expired',
  'cancelled',
]);
/** Statuses during which the candidate is actively interviewing. */
export const LIVE_STATUSES: ReadonlySet<InterviewStatus> = new Set(['in_progress', 'coding']);

export const EVALUATION_STATUSES = ['none', 'queued', 'running', 'failed', 'succeeded'] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

export const INTERVIEW_ACTIONS = [
  'view_brief',
  'acknowledge_brief',
  'accept',
  'decline',
  'cancel',
  'prepare',
  'start',
  'resume',
  'answer',
  'finish_conversation',
  'code',
  'submit_code',
  'view_report',
  'retry_evaluation',
  'withdraw_consent',
] as const;
export type InterviewAction = (typeof INTERVIEW_ACTIONS)[number];

export const CANCELLATION_REASONS = [
  'founder_cancelled',
  'candidate_cancelled',
  'brief_closed',
  'consent_withdrawn',
  'blocked',
  'account_suspended',
  /** View-only: blocks and suspensions are never named to the other person. */
  'unavailable',
] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

// --- Consent ------------------------------------------------------------------------------------

export const INTERVIEW_CONSENT_POLICY_VERSION = 'interview-ai-v1' as const;

/**
 * Consents shown before acceptance. `assessment` and `external_ai_processing` are required: the
 * interview cannot run without AI question generation and evaluation. `speech_transcription` is
 * optional; without it every answer is typed and nothing is penalised.
 */
export const INTERVIEW_CONSENT_ITEMS = [
  'assessment',
  'external_ai_processing',
  'speech_transcription',
] as const;
export type InterviewConsentItem = (typeof INTERVIEW_CONSENT_ITEMS)[number];
export const REQUIRED_INTERVIEW_CONSENTS: readonly InterviewConsentItem[] = [
  'assessment',
  'external_ai_processing',
];

export interface InterviewConsentSnapshot {
  policyVersion: typeof INTERVIEW_CONSENT_POLICY_VERSION;
  items: Record<InterviewConsentItem, boolean>;
  grantedAt: string;
  /** Provider labels disclosed at consent time (e.g. "groq:llama-3.3-70b-versatile"). */
  disclosedProviders: string[];
  withdrawnAt: string | null;
}

export function missingInterviewConsents(
  items: Partial<Record<InterviewConsentItem, boolean>> | null,
): InterviewConsentItem[] {
  return REQUIRED_INTERVIEW_CONSENTS.filter((i) => items?.[i] !== true);
}

export const INTERVIEW_PRIVACY_NOTICE =
  'Your resume text (with contact details removed), your answers and your code are sent to the ' +
  'configured AI provider to generate questions and evaluate answers. Removal of personal ' +
  'details is best-effort and is not a guarantee of anonymity, so do not include personal ' +
  'information in your answers. Answer audio is transcribed by our own speech service and ' +
  'deleted immediately; it is never stored. If you turn on your camera, the picture is shown only ' +
  'to you on your own screen: it is never recorded, uploaded or analysed. Transcripts, code and the ' +
  'report are kept for 12 months after the brief closes (at most 18 months after the ' +
  'invitation) and are shared only with the founder who invited you.';

export const PROVIDER_RETENTION_NOTICE =
  'The AI provider is a separate company with its own terms. Requests already sent to it cannot ' +
  'be recalled, and its own retention and logging rules apply. See the provider documentation ' +
  'listed in the interview readiness screen.';

export const INTERVIEW_REPORT_NOTICE =
  'Experimental AI-assisted assessment. It supports human review and is not a hiring decision. ' +
  'Unaided work and future collaboration success are not verified.';

// --- Questions and answers ----------------------------------------------------------------------

export const QUESTION_TYPES = [
  'background',
  'resume_project',
  'fundamentals',
  'architecture',
  'problem_solving',
  'scenario',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** How the interviewer reads the last answer — for steering only, never a score. */
export const ANSWER_SIGNALS = [
  'strong',
  'partial',
  'vague',
  'incorrect',
  'unclear_audio',
  'no_answer',
  'not_applicable',
] as const;
export type AnswerSignal = (typeof ANSWER_SIGNALS)[number];

export const TURN_INTENTS = [
  'new_topic',
  'go_deeper',
  'focused_follow_up',
  'request_example',
  'check_understanding',
  'implementation_detail',
  'clarify',
] as const;
export type TurnIntent = (typeof TURN_INTENTS)[number];

export const QUESTION_TYPE_LABELS: Readonly<Record<QuestionType, string>> = {
  background: 'Background',
  resume_project: 'Resume project',
  fundamentals: 'Fundamentals',
  architecture: 'Architecture & decisions',
  problem_solving: 'Problem solving',
  scenario: 'Scenario',
};

export const TURN_INTENT_LABELS: Readonly<Record<TurnIntent, string>> = {
  new_topic: 'New topic',
  go_deeper: 'Going deeper',
  focused_follow_up: 'Follow-up',
  request_example: 'Asking for an example',
  check_understanding: 'Checking understanding',
  implementation_detail: 'Implementation detail',
  clarify: 'Clarifying',
};

export type AnswerInputMode = 'voice' | 'typed';
export type SkipReason = 'manual_skip' | 'conversation_timeout' | 'session_timeout';

export type TranscriptConfidence = 'high' | 'medium' | 'low';

/** One transcribed segment as shown to the candidate for correction. */
export interface TranscriptSegmentView {
  text: string;
  startSec: number;
  endSec: number;
  /** Low recognition confidence: the words may be wrong. */
  uncertain: boolean;
  /** Audio was unclear and no words were kept ("[unclear audio]"). */
  dropped: boolean;
}

export interface TranscriptDraftView {
  /** Text with unclear stretches marked "[unclear audio]"; never invented words. */
  text: string;
  segments: TranscriptSegmentView[];
  confidence: TranscriptConfidence;
  noSpeech: boolean;
  durationSec: number;
  recordingsUsed: number;
}

export interface AnswerView {
  text: string;
  inputMode: AnswerInputMode;
  /** The unedited speech-to-text output (voice answers only). */
  transcriptOriginal: string | null;
  transcriptConfidence: TranscriptConfidence | null;
  uncertainSegments: number;
  /** The candidate changed the transcript before submitting. */
  edited: boolean;
  /** Share of words changed by the candidate, 0-1 (voice answers only). */
  editRatio: number | null;
  skipped: boolean;
  skipReason: SkipReason | null;
  submittedAt: string;
}

export interface TurnView {
  index: number;
  kind: 'intro' | 'question';
  questionType: QuestionType | null;
  topic: string | null;
  intent: TurnIntent | null;
  difficulty: number | null;
  prompt: string;
  /** Index of the question this follows up on. */
  parentIndex: number | null;
  /** Resume quote the question is based on (exact substring of the redacted resume text). */
  resumeEvidence: string | null;
  askedAt: string;
  answer: AnswerView | null;
  /** Candidate only: the latest unsubmitted transcript. */
  draft: TranscriptDraftView | null;
}

export type GenerationStatus = 'idle' | 'running' | 'failed';

export interface InterviewProgress {
  stage: 'not_started' | 'conversation' | 'coding' | 'done';
  questionsAsked: number;
  questionsAnswered: number;
  maxQuestions: number;
  minQuestions: number;
  topicsCovered: QuestionType[];
}

/** Why an interview cannot start yet, with an action the candidate can take. */
export type ResumeReadiness =
  | { ready: true; resumeVersion: number }
  | {
      ready: false;
      reason: 'no_resume' | 'no_text' | 'consent_missing';
      message: string;
    };

/**
 * Interview preparation (amendment to Phases 7-8): after acceptance the server reads the resume,
 * extracts projects and tech stack, and prepares the opening question of every planned topic in
 * advance. Start is enabled only when the plan is ready for the current resume version.
 */
export const QUESTION_PREPARATION_STATUSES = [
  'waiting_for_resume',
  'not_started',
  'preparing',
  'ready',
  'stale',
  'failed',
] as const;
export type QuestionPreparationStatus = (typeof QUESTION_PREPARATION_STATUSES)[number];

export interface QuestionPreparation {
  status: QuestionPreparationStatus;
  /** Number of prepared topic questions (follow-ups are still generated live). */
  plannedCount: number;
  /** What the plan is based on (the candidate's own resume): project names and technologies. */
  basedOn: { projects: string[]; technologies: string[] } | null;
  /** Resume version the plan was prepared from. */
  resumeVersion: number | null;
  message: string | null;
}

export interface InterviewReadiness {
  resume: ResumeReadiness;
  /** Questions prepared from the resume; Start requires status "ready". */
  questions: QuestionPreparation;
  /** Speech-to-text service configured (voice answers possible). */
  speechToText: { available: boolean; message: string | null };
  /** Text-to-speech configured (spoken questions). Questions are always shown as text too. */
  textToSpeech: { available: boolean; message: string | null };
  /** AI interviewer configured; without it the interview cannot start. */
  interviewer: { available: boolean; message: string | null; providers: string[] };
  codeExecution: { available: boolean; message: string | null };
  approximateMinutes: number;
}

export function resumeReadinessMessage(
  reason: 'no_resume' | 'no_text' | 'consent_missing',
): string {
  switch (reason) {
    case 'no_resume':
      return 'Upload your English resume (PDF) in your profile before starting. The interview is based on it.';
    case 'no_text':
      return 'Your resume has no extractable text (it may be a scanned image). Upload a text-based PDF exported from your editor.';
    case 'consent_missing':
      return 'Resume processing consent is missing. Upload your resume again and agree to the processing notice.';
  }
}

// --- Coding round -------------------------------------------------------------------------------

export const CODE_LANGUAGES = ['javascript', 'python'] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];
export const CODE_LANGUAGE_LABELS: Readonly<Record<CodeLanguage, string>> = {
  javascript: 'JavaScript (Node.js)',
  python: 'Python 3',
};

export const CODING_TASK_KINDS = [
  'fix_bug',
  'complete_function',
  'improve_efficiency',
  'handle_edge_cases',
] as const;
export type CodingTaskKind = (typeof CODING_TASK_KINDS)[number];
export const CODING_TASK_KIND_LABELS: Readonly<Record<CodingTaskKind, string>> = {
  fix_bug: 'Fix a bug',
  complete_function: 'Complete a function',
  improve_efficiency: 'Improve inefficient code',
  handle_edge_cases: 'Handle edge cases',
};

export interface CodingTaskView {
  taskId: string;
  taskVersion: string;
  title: string;
  kind: CodingTaskKind;
  prompt: string;
  functionName: Record<CodeLanguage, string>;
  starterCode: Record<CodeLanguage, string>;
  /** Visible tests only; hidden tests never leave the server before evaluation. */
  visibleTests: Array<{ name: string; input: string; expected: string }>;
  hiddenTestCount: number;
  selectionReason: string;
}

export type TestOutcome = 'passed' | 'failed' | 'error' | 'timeout';

export interface TestResultView {
  name: string;
  outcome: TestOutcome;
  /** Visible tests only. */
  expected: string | null;
  actual: string | null;
  message: string | null;
}

export type ExecutionStatus =
  'completed' | 'compile_error' | 'runtime_error' | 'timeout' | 'memory_limit' | 'internal_error';

export interface CodeRunView {
  at: string;
  language: CodeLanguage;
  status: ExecutionStatus;
  results: TestResultView[];
  passed: number;
  total: number;
  /** Bounded compiler/runtime output (stderr), visible to the candidate only. */
  diagnostics: string | null;
}

export interface CodingView {
  task: CodingTaskView;
  startedAt: string;
  deadline: string;
  draft: { language: CodeLanguage; code: string; explanation?: string; savedAt: string } | null;
  runs: CodeRunView[];
  runsRemaining: number;
  execution: { available: boolean; message: string | null };
  submission: {
    language: CodeLanguage;
    code: string;
    explanation: string;
    submittedAt: string;
    autoSubmitted: boolean;
  } | null;
}

// --- Session DTOs -------------------------------------------------------------------------------

export interface InterviewParty {
  displayName: string;
  demoAccount: boolean;
}

export interface InterviewSummary {
  id: string;
  briefId: string;
  briefVersion: number;
  briefTitle: string;
  status: InterviewStatus;
  evaluationStatus: EvaluationStatus;
  candidateUserId: string;
  /** Participant id (Phase 14: block/report controls); never contact details. */
  founderUserId: string;
  candidate: InterviewParty;
  founder: InterviewParty;
  invitedAt: string;
  expiresAt: string;
  submittedAt: string | null;
  allowedActions: InterviewAction[];
}

export interface InterviewSessionView extends InterviewSummary {
  viewerRole: 'founder' | 'candidate';
  serverNow: string;
  /** Teaser/terms snapshot frozen at invitation. */
  brief: BriefPreview;
  /** Full confidential brief: owner, or the candidate after acknowledging confidentiality. */
  fullBrief: StartupBriefData | null;
  briefAccessAcknowledgedAt: string | null;
  acceptedAt: string | null;
  startedAt: string | null;
  conversationDeadline: string | null;
  codingDeadline: string | null;
  globalDeadline: string | null;
  consent: InterviewConsentSnapshot | null;
  cancellationReason: CancellationReason | null;
  /** Candidate only, before and during the interview. */
  readiness: InterviewReadiness | null;
  progress: InterviewProgress;
  /** Candidate: own turns. Founder: only after submission. */
  turns: TurnView[];
  currentTurnIndex: number | null;
  generation: { status: GenerationStatus; message: string | null };
  coding: CodingView | null;
  /** Another tab or device took over the live room. */
  activeElsewhere: boolean;
  /** Candidate profile revision a pending acceptance must confirm. */
  currentProfileRevision: number | null;
  reportAvailable: boolean;
}

// --- Requests -------------------------------------------------------------------------------------

export interface InterviewCreateRequest {
  briefId: string;
  candidateUserId: string;
  batchId: string;
}

export interface InterviewAcceptRequest {
  briefVersion: number;
  profileRevision: number;
  consent: {
    policyVersion: typeof INTERVIEW_CONSENT_POLICY_VERSION;
    items: Record<InterviewConsentItem, boolean>;
  };
}

export interface AnswerSubmitRequest {
  text: string;
  inputMode: AnswerInputMode;
  skip?: boolean;
}

export const INTERVIEW_CLIENT_HEADER = 'X-Interview-Client' as const;
export const INTERVIEW_TURN_HEADER = 'X-Interview-Turn' as const;

export const AUDIO_CONTENT_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/wav',
  'audio/mp4',
  'audio/mpeg',
] as const;

/** Content-Type without parameters (e.g. "audio/webm;codecs=opus" -> "audio/webm"). */
export function baseContentType(value: string | null | undefined): string {
  return (value ?? '').split(';')[0]!.trim().toLowerCase();
}

export function isSupportedAudioType(value: string | null | undefined): boolean {
  return (AUDIO_CONTENT_TYPES as readonly string[]).includes(baseContentType(value));
}

export type QuestionSkillTargets = SkillId[];
