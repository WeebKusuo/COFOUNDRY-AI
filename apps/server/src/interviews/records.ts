import type {
  AnswerInputMode,
  AnswerSignal,
  BriefPreview,
  CancellationReason,
  CodeLanguage,
  CodeRunView,
  EvaluationStatus,
  InterviewConsentSnapshot,
  InterviewStatus,
  QuestionType,
  ResumeRef,
  SkillId,
  SkipReason,
  StartupBriefData,
  TranscriptConfidence,
  TranscriptSegmentView,
  TurnIntent,
} from '@cofoundry/shared';
import type { PlannedQuestion, ResumeContext } from '../ai/types.js';

/**
 * Persisted interview session (one document per brief/candidate pair). Nested values use ISO
 * strings so the document round-trips identically through MongoDB and the in-memory test store.
 * Every mutation is a conditional replace on `rev` (optimistic concurrency).
 */

export interface TranscriptDraftRecord {
  text: string;
  original: string;
  segments: TranscriptSegmentView[];
  confidence: TranscriptConfidence;
  noSpeech: boolean;
  durationSec: number;
  uncertainSegments: number;
  recordingsUsed: number;
  model: string;
  createdAt: string;
}

export interface AnswerRecord {
  text: string;
  inputMode: AnswerInputMode;
  transcriptOriginal: string | null;
  transcriptConfidence: TranscriptConfidence | null;
  uncertainSegments: number;
  edited: boolean;
  editRatio: number | null;
  skipped: boolean;
  skipReason: SkipReason | null;
  submittedAt: string;
  injectionSuspected: boolean;
}

export interface TurnRecord {
  index: number;
  kind: 'intro' | 'question';
  questionType: QuestionType | null;
  topic: string | null;
  intent: TurnIntent | null;
  difficulty: number | null;
  prompt: string;
  parentIndex: number | null;
  resumeEvidence: string | null;
  targetSkills: SkillId[];
  /** Hidden from every DTO; given to the evaluator only. */
  expectedConcepts: string[];
  askedAt: string;
  /** The interviewer's steering read of THIS turn's answer (set when the next turn is generated). */
  steeringSignal: AnswerSignal | null;
  generatedBy: { provider: string; model: string | null; promptVersion: string } | null;
  draft: TranscriptDraftRecord | null;
  answer: AnswerRecord | null;
}

/** `preparation` runs while the interview is accepted: resume context, then the question plan. */
export type GenerationPurpose = 'preparation' | 'question' | 'coding_setup';

/** A prepared topic question (hidden concepts included; never sent to a client as such). */
export interface PlannedQuestionRecord extends PlannedQuestion {
  generatedBy: { provider: string; model: string | null; promptVersion: string };
}

export interface GenerationState {
  status: 'idle' | 'running' | 'failed';
  purpose: GenerationPurpose | null;
  token: string | null;
  leaseUntil: string | null;
  failures: number;
  lastErrorCode: string | null;
  /** When the last failure happened (absent on records written before it was added). */
  failedAt?: string | null;
}

export interface CodingRecord {
  taskId: string;
  taskVersion: string;
  selection: {
    method: 'ai' | 'rule_based';
    reason: string;
    provider: string | null;
    model: string | null;
  };
  startedAt: string;
  deadline: string;
  /** Autosaved work; `explanation` is absent on drafts saved before it was added. */
  draft: { language: CodeLanguage; code: string; explanation?: string; savedAt: string } | null;
  runs: CodeRunView[];
  runCount: number;
  submission: {
    language: CodeLanguage;
    code: string;
    explanation: string;
    submittedAt: string;
    autoSubmitted: boolean;
  } | null;
}

export interface ProfileSnapshot {
  revision: number;
  headline: string;
  skills: Array<{ skillId: SkillId; level: number }>;
  projects: Array<{ title: string; description: string; skillTags: SkillId[] }>;
  availableHoursPerWeek: number | null;
  commitmentMonths: number | null;
}

export interface InterviewRecord {
  id: string;
  rev: number;
  briefId: string;
  briefVersion: number;
  candidateUserId: string;
  founderUserId: string;
  recommendationBatchId: string;
  status: InterviewStatus;
  evaluationStatus: EvaluationStatus;
  invitedAt: Date;
  expiresAt: Date;
  briefPreview: BriefPreview;
  briefFull: StartupBriefData;
  briefAccessAt: Date | null;
  acceptedAt: Date | null;
  declinedAt: Date | null;
  declineReason: string | null;
  cancelledAt: Date | null;
  cancellationReason: CancellationReason | null;
  cancellationNote: string | null;
  consent: InterviewConsentSnapshot | null;
  consentRecordId: string | null;
  profileSnapshot: ProfileSnapshot | null;
  resumeRef: ResumeRef | null;
  /** Redacted, bounded resume text the models received (needed for evidence checks). */
  resumeTextForAi: string | null;
  resumeContext: ResumeContext | null;
  resumeInjectionSuspected: boolean;
  /**
   * Prepared before start from resumeRef's resume (absent on records created before the
   * preparation step: those generate every question live).
   */
  questionPlan?: PlannedQuestionRecord[] | null;
  preparedAt?: Date | null;
  startedAt: Date | null;
  conversationDeadline: Date | null;
  globalDeadline: Date | null;
  codingDeadline: Date | null;
  submittedAt: Date | null;
  turns: TurnRecord[];
  generation: GenerationState;
  coding: CodingRecord | null;
  activeClientId: string | null;
  lastHeartbeatAt: Date | null;
  manualRetriesUsed: number;
  reportId: string | null;
  /** Retention: set when personal content was removed (terminal pre-submit after 30 days). */
  minimizedAt: Date | null;
  /**
   * Phase 14: a block between the pair ended the founder's access to this assessment (absent on
   * records created before Phase 14 = never blocked). Unblocking does not restore it.
   */
  blockedAt?: Date | null;
  /** Phase 14: a moderator quarantined the report (no new requests; AI narrative hidden). */
  reportQuarantinedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const IDLE_GENERATION: GenerationState = {
  status: 'idle',
  purpose: null,
  token: null,
  leaseUntil: null,
  failures: 0,
  lastErrorCode: null,
};

// --- Durable evaluation jobs and reports ----------------------------------------------------------

export interface StepProvenance {
  provider: string;
  model: string | null;
  promptVersion: string;
  evaluatedAt: string;
}

export interface JudgmentRecord {
  level: number | null;
  rationale: string;
  evidence: string[];
}

export interface AnswerEvaluationRecord {
  status: 'evaluated' | 'skipped' | 'not_assessed';
  notAssessedReason: string | null;
  dimensions: Record<string, JudgmentRecord> | null;
  downgradedDimensions: string[];
  conceptsDemonstrated: string[];
  conceptsMissing: string[];
  incorrectStatements: Array<{ quote: string; issue: string }>;
  strengths: Array<{ point: string; evidence: string }>;
  gaps: Array<{ point: string; kind: 'incorrect' | 'missing_evidence' }>;
  uncertainty: { level: 'low' | 'medium' | 'high'; reasons: string[] } | null;
  transcriptionIssuesSuspected: boolean;
  provenance: StepProvenance | null;
}

export interface CommunicationRecord {
  status: 'evaluated' | 'not_assessed';
  notAssessedReason: string | null;
  dimensions: Record<string, JudgmentRecord> | null;
  overallFeedback: string;
  strengths: string[];
  suggestions: string[];
  provenance: StepProvenance | null;
}

export interface CodeGradeRecord {
  status: 'executed' | 'unavailable' | 'failed' | 'not_run';
  message: string | null;
  compileError: boolean;
  diagnostics: string | null;
  tests: Array<{
    name: string;
    category: 'visible' | 'hidden' | 'performance';
    outcome: 'passed' | 'failed' | 'error' | 'timeout';
  }>;
  judge: string;
  gradedAt: string;
}

export interface CodeReviewRecord {
  status: 'evaluated' | 'not_assessed';
  notAssessedReason: string | null;
  dimensions: Record<string, JudgmentRecord> | null;
  explanationFeedback: string;
  improvements: string[];
  issues: Array<{ line: number | null; comment: string }>;
  summary: string;
  provenance: StepProvenance | null;
}

export interface EvaluationSteps {
  answers: Record<string, AnswerEvaluationRecord>;
  communication: CommunicationRecord | null;
  codeGrade: CodeGradeRecord | null;
  codeReview: CodeReviewRecord | null;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface EvaluationJobRecord {
  id: string;
  sessionId: string;
  founderUserId: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  nextRunAt: Date;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  lastErrorCode: string | null;
  steps: EvaluationSteps;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export const EMPTY_STEPS: EvaluationSteps = {
  answers: {},
  communication: null,
  codeGrade: null,
  codeReview: null,
};

export interface ReportRecord {
  id: string;
  sessionId: string;
  version: number;
  rubricVersion: string;
  generatedAt: Date;
  /** The computed report (InterviewReportView without per-request fields). */
  data: unknown;
}
