import type {
  AnswerInputMode,
  CodeLanguage,
  CodingTaskKind,
  EvaluationStatus,
  QuestionType,
  SkipReason,
  TestOutcome,
  TranscriptConfidence,
  TurnIntent,
} from './interview.js';
import type {
  CodeReviewDimension,
  CommunicationDimension,
  EvidenceLevel,
  TechnicalDimension,
} from './rubric.js';

/** Interview report DTOs (Phase 10). Both participants read the same report. */

export interface DimensionJudgment {
  level: number | null;
  rationale: string;
  /** Exact quotes from the answer that support the level. */
  evidence: string[];
}

export interface ProvenanceView {
  provider: string;
  model: string | null;
  promptVersion: string;
  evaluatedAt: string;
}

export interface QuestionEvaluationView {
  index: number;
  questionType: QuestionType | null;
  topic: string | null;
  intent: TurnIntent | null;
  difficulty: number | null;
  prompt: string;
  resumeEvidence: string | null;
  answer: {
    text: string;
    inputMode: AnswerInputMode;
    transcriptConfidence: TranscriptConfidence | null;
    uncertainSegments: number;
    edited: boolean;
    editRatio: number | null;
    skipped: boolean;
    skipReason: SkipReason | null;
  } | null;
  status: 'evaluated' | 'skipped' | 'not_assessed';
  /** Why the answer was not assessed (e.g. evaluation failed, unclear audio). */
  notAssessedReason: string | null;
  score: number | null;
  dimensions: Record<TechnicalDimension, DimensionJudgment> | null;
  conceptsDemonstrated: string[];
  conceptsMissing: string[];
  incorrectStatements: Array<{ quote: string; issue: string }>;
  strengths: Array<{ point: string; evidence: string }>;
  gaps: Array<{ point: string; kind: 'incorrect' | 'missing_evidence' }>;
  uncertainty: { level: 'low' | 'medium' | 'high'; reasons: string[] } | null;
  transcriptionIssuesSuspected: boolean;
  provenance: ProvenanceView | null;
}

export interface CommunicationReportView {
  status: 'evaluated' | 'not_assessed';
  notAssessedReason: string | null;
  score: number | null;
  dimensions: Record<CommunicationDimension, DimensionJudgment> | null;
  overallFeedback: string;
  strengths: string[];
  suggestions: string[];
  provenance: ProvenanceView | null;
  notice: string;
}

export interface CodingReportView {
  task: {
    taskId: string;
    taskVersion: string;
    title: string;
    kind: CodingTaskKind;
    prompt: string;
    selectionReason: string;
  };
  submission: {
    language: CodeLanguage;
    code: string;
    explanation: string;
    submittedAt: string;
    autoSubmitted: boolean;
  } | null;
  execution: {
    status: 'executed' | 'unavailable' | 'failed' | 'not_run';
    message: string | null;
    compileError: boolean;
    diagnostics: string | null;
  };
  tests: Array<{
    name: string;
    category: 'visible' | 'hidden' | 'performance';
    outcome: TestOutcome;
  }>;
  testsPassed: number;
  testsTotal: number;
  functionalScore: number | null;
  efficiencyScore: number | null;
  review: {
    status: 'evaluated' | 'not_assessed';
    notAssessedReason: string | null;
    dimensions: Record<CodeReviewDimension, DimensionJudgment> | null;
    explanationFeedback: string;
    improvements: string[];
    issues: Array<{ line: number | null; comment: string }>;
    summary: string;
    provenance: ProvenanceView | null;
  };
  qualityScore: number | null;
  score: number | null;
}

export interface InterviewReportView {
  interviewId: string;
  reportVersion: number;
  rubricVersion: string;
  generatedAt: string;
  evaluationStatus: EvaluationStatus;
  retryAllowed: boolean;
  candidate: { displayName: string; demoAccount: boolean };
  briefTitle: string;
  briefVersion: number;
  summary: string;
  overall: {
    score: number | null;
    evidenceLevel: EvidenceLevel;
    basis: Array<'technical' | 'coding'>;
  };
  technical: {
    score: number | null;
    asked: number;
    assessed: number;
    coverage: number;
    byType: Array<{ questionType: QuestionType; score: number | null; count: number }>;
    byDimension: Array<{ dimension: TechnicalDimension; meanLevel: number | null }>;
  };
  questions: QuestionEvaluationView[];
  resumeUnderstanding: {
    projectQuestions: number;
    meanScore: number | null;
    notes: string[];
  };
  strengths: Array<{ point: string; evidence: string; questionIndex: number }>;
  knowledgeGaps: Array<{
    point: string;
    kind: 'incorrect' | 'missing_evidence';
    questionIndex: number;
  }>;
  communication: CommunicationReportView;
  coding: CodingReportView | null;
  methodology: {
    technicalWeights: Record<TechnicalDimension, number>;
    codingWeights: { functional: number; efficiency: number; quality: number };
    overallWeights: { technical: number; coding: number };
    evidenceBands: { strong: number; moderate: number };
    minCoverage: number;
    explanation: string[];
  };
  limitations: string[];
  reviewRecommendations: string[];
  /** Content resembling instructions to the AI was found in candidate-supplied text. */
  injectionFlags: Array<{ source: 'resume' | 'answer' | 'code'; questionIndex: number | null }>;
  notice: string;
  /**
   * Phase 14 overlays (both participants see them): moderator-attributed correction text, the
   * number of open correction cases (shown, never an automatic rejection) and quarantine. A
   * quarantined report hides the disputed AI narrative; source answers and numbers remain.
   */
  corrections?: Array<{ caseId: string; text: string; at: string; by: 'CoFoundry moderator' }>;
  openCorrections?: number;
  quarantine?: { at: string; notice: string } | null;
}

/** A report that is not finished yet: sources are visible, numbers are null. */
export interface PendingReportView {
  interviewId: string;
  evaluationStatus: EvaluationStatus;
  retryAllowed: boolean;
  message: string;
}

export type ReportResponse =
  | { state: 'ready'; report: InterviewReportView }
  | { state: 'pending'; pending: PendingReportView };
