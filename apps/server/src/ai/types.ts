/**
 * AI provider architecture — capability ports (Phases 7-10).
 *
 * Every LLM feature is a *capability* behind a small port interface. Adapters implement a
 * provider (Groq's OpenAI-compatible API, a self-hosted OpenAI-compatible server, or the
 * deterministic test double), so a model can be swapped by configuration without touching
 * business logic. Speech-to-text, text-to-speech and code execution have their own interfaces
 * (src/speech, src/coding) because they are not LLM calls.
 *
 * Rules that hold for every capability:
 *  - Adapters receive only the minimum data: no user ids, emails, phone numbers, contact fields,
 *    credentials or the brief's confidential problem/solution. Candidate text (resume, answers,
 *    code) is passed as delimited JSON *data*, never as instructions.
 *  - Every call requires the candidate's interview consent (assessment + external processing).
 *  - Adapters return bounded per-dimension judgments; the backend validates them strictly (no
 *    clamping or repair) and computes every aggregate itself.
 *  - Credentials stay server-side; only metadata (capability, provider, model, latency, tokens,
 *    error code) is logged — never prompts, resume text, transcripts or code.
 */

import type {
  AnswerInputMode,
  AnswerSignal,
  CodeLanguage,
  CodingTaskKind,
  CodeReviewDimension,
  CommunicationDimension,
  QuestionType,
  SkillId,
  TechnicalDimension,
  TranscriptConfidence,
  TurnIntent,
} from '@cofoundry/shared';
import type { INTERVIEW_CONTRACT_VERSION, ROLE_KEY } from '@cofoundry/shared';

export const AI_CAPABILITIES = [
  'resume_context',
  'question_plan',
  'interview_turn',
  'coding_task_selection',
  'answer_evaluation',
  'communication_evaluation',
  'code_review',
] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];

/** Capabilities served by the interviewer model; the rest use the evaluator model. */
export const INTERVIEWER_CAPABILITIES: ReadonlySet<AiCapability> = new Set([
  'resume_context',
  'question_plan',
  'interview_turn',
  'coding_task_selection',
]);

/** Server-side provider settings (from LLM_* environment variables; see config/env.ts). */
export interface AiProviderSettings {
  provider: string;
  /** Model for question generation, follow-ups, resume context and task selection. */
  interviewerModel: string | null;
  /** Separately configured model for answer, communication and code evaluation. */
  evaluatorModel: string | null;
  apiKey: string | null;
  /** OpenAI-compatible base URL, e.g. https://api.groq.com/openai/v1 */
  baseUrl: string | null;
  /** Allow plain http for a self-hosted model server on localhost. */
  allowInsecureHttp?: boolean;
}

/** The subset of the pino logger the AI module uses (metadata only — never payloads). */
export interface AiLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export type ProviderErrorCode =
  | 'disabled'
  | 'timeout'
  | 'cancelled'
  | 'rate_limited'
  | 'upstream_failed'
  | 'invalid_output'
  | 'consent_missing';

export interface ProviderDescriptor {
  capability: AiCapability;
  /** Stable provider label, e.g. "disabled", "groq", "mock". */
  providerId: string;
  /** Exact model identifier recorded on every stored artefact; null when disabled. */
  model: string | null;
  /** Adapter version — bump when request/parsing behaviour changes. */
  adapterVersion: string;
  /** Prompt version — bump when a prompt changes; stored with every output. */
  promptVersion: string;
}

export interface CallMeta {
  providerId: string;
  model: string | null;
  promptVersion: string;
  latencyMs: number;
  attempts: number;
  inputTokens?: number;
  outputTokens?: number;
}

export type ProviderResult<T> =
  | { ok: true; value: T; meta: CallMeta }
  | { ok: false; error: { code: ProviderErrorCode; message: string }; meta: CallMeta };

/** Proof that the candidate granted interview consent (stored ConsentRecord). */
export interface ConsentProof {
  purpose: 'assessment';
  consentRecordId: string;
  policyVersion: string;
}

export interface CallContext {
  signal: AbortSignal;
  consent: ConsentProof;
}

/** Raw adapter output plus optional token usage reported by the provider. */
export interface AdapterOutput {
  output: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
}

// ---------------------------------------------------------------------------------------------
// Capability inputs (outputs: zod schemas in contracts.ts)
// ---------------------------------------------------------------------------------------------

interface Versioned {
  contractVersion: typeof INTERVIEW_CONTRACT_VERSION;
  roleKey: typeof ROLE_KEY;
  language: 'en';
}

export interface RequiredSkillInput {
  skillId: SkillId;
  level: number;
  importance: number;
}

/** Structure the candidate's (redacted) resume once per interview. */
export interface ResumeContextInput extends Versioned {
  /** Redacted resume text, delimited as data. */
  resumeText: string;
  truncated: boolean;
}

export interface ResumeContext {
  skills: string[];
  projects: Array<{
    name: string;
    summary: string;
    technologies: string[];
    contributions: string[];
    /** Exact substring of the redacted resume text. */
    evidence: string;
  }>;
  experience: Array<{ summary: string; evidence: string }>;
  achievements: Array<{ text: string; evidence: string }>;
}

/** One planned topic slot: the server fixes the question type and difficulty range. */
export interface QuestionPlanSlot {
  slot: number;
  type: QuestionType;
  difficultyMin: number;
  difficultyMax: number;
}

/**
 * Prepare the opening question of every planned topic before the interview starts, grounded in
 * the candidate's resume projects and tech stack and the role requirements.
 */
export interface QuestionPlanInput extends Versioned {
  role: { requiredSkills: RequiredSkillInput[] };
  candidate: {
    skills: Array<{ skillId: SkillId; level: number }>;
    resumeContext: ResumeContext;
  };
  slots: QuestionPlanSlot[];
}

export interface PlannedQuestion {
  slot: number;
  type: QuestionType;
  topic: string;
  difficulty: number;
  prompt: string;
  targetSkills: SkillId[];
  /** Exact quote of the redacted resume text; required for resume_project. */
  resumeEvidence: string | null;
  expectedConcepts: string[];
}

export interface QuestionPlanOutput {
  questions: PlannedQuestion[];
}

export interface TurnHistoryItem {
  index: number;
  questionType: QuestionType;
  topic: string;
  intent: TurnIntent;
  difficulty: number;
  prompt: string;
  /** Redacted answer text (recent turns only; null for older turns or skipped answers). */
  answer: string | null;
  answerStatus: 'answered' | 'skipped';
  inputMode: AnswerInputMode | null;
  transcriptConfidence: TranscriptConfidence | null;
}

/** Server-computed constraints the interviewer must follow (validated on the way back). */
export interface TurnPolicy {
  /** The question type for a new topic (the server rotates through the coverage plan). */
  newTopicType: QuestionType;
  /** True when follow-up depth or attempts are exhausted: the next question opens a new topic. */
  mustChangeTopic: boolean;
  followUpDepth: number;
  maxFollowUpDepth: number;
  coveredTopics: string[];
  difficultyMin: number;
  difficultyMax: number;
  remainingQuestions: number;
  remainingMinutes: number;
  /** The conversation may end now (enough questions answered, all question types covered). */
  mayEnd: boolean;
  /** Required intent of a follow-up for each reading of the last answer. */
  intentForSignal: Record<AnswerSignal, TurnIntent>;
}

export interface InterviewTurnInput extends Versioned {
  role: { requiredSkills: RequiredSkillInput[] };
  candidate: {
    skills: Array<{ skillId: SkillId; level: number }>;
    resumeContext: ResumeContext;
  };
  history: TurnHistoryItem[];
  /** Index of the answer just given; null before the first question. */
  lastAnswerIndex: number | null;
  policy: TurnPolicy;
  /**
   * The prepared question for the next new topic (from the question plan), or null. When the
   * interviewer opens a new topic, the server asks this prepared question.
   */
  plannedNext: { type: QuestionType; topic: string; prompt: string } | null;
}

export interface TurnQuestion {
  type: QuestionType;
  topic: string;
  intent: TurnIntent;
  difficulty: number;
  prompt: string;
  targetSkills: SkillId[];
  /** Required for resume_project questions: exact quote from the resume context evidence. */
  resumeEvidence: string | null;
  /** Index of the question being followed up; null for a new topic. */
  followsUp: number | null;
  /** Hidden concepts a strong answer would cover — used by the evaluator, never shown. */
  expectedConcepts: string[];
}

export interface InterviewTurnOutput {
  assessment: { signal: AnswerSignal; note: string };
  decision: 'ask' | 'end';
  question: TurnQuestion | null;
}

export interface CodingTaskSelectionInput extends Versioned {
  roleSkills: SkillId[];
  candidateSkills: Array<{ skillId: SkillId; level: number }>;
  conversation: Array<{ questionType: QuestionType; topic: string; signal: AnswerSignal }>;
  tasks: Array<{
    id: string;
    title: string;
    kind: CodingTaskKind;
    skills: SkillId[];
    difficulty: number;
  }>;
}

export interface DimensionDefinitionInput {
  label: string;
  levels: readonly string[];
}

export interface AnswerEvaluationInput extends Versioned {
  rubricVersion: string;
  rubric: Record<TechnicalDimension, DimensionDefinitionInput>;
  question: {
    type: QuestionType;
    topic: string;
    difficulty: number;
    prompt: string;
    expectedConcepts: string[];
    resumeEvidence: string | null;
  };
  roleSkills: SkillId[];
  answer: {
    text: string;
    inputMode: AnswerInputMode;
    transcriptConfidence: TranscriptConfidence | null;
    uncertainSegments: number;
    edited: boolean;
  };
  /** The parent question chain this answer follows up on (bounded, redacted). */
  relatedHistory: Array<{ prompt: string; answer: string }>;
}

export interface CommunicationEvaluationInput extends Versioned {
  rubricVersion: string;
  rubric: Record<CommunicationDimension, DimensionDefinitionInput>;
  answers: Array<{
    index: number;
    prompt: string;
    text: string;
    inputMode: AnswerInputMode;
    transcriptConfidence: TranscriptConfidence | null;
  }>;
}

export interface CodeReviewInput extends Versioned {
  rubricVersion: string;
  rubric: Record<CodeReviewDimension, DimensionDefinitionInput>;
  task: { title: string; kind: CodingTaskKind; prompt: string; language: CodeLanguage };
  code: string;
  explanation: string;
  tests: {
    execution: 'executed' | 'unavailable' | 'failed';
    passed: number;
    total: number;
    compileError: boolean;
  };
}

export interface CapabilityInputs {
  resume_context: ResumeContextInput;
  question_plan: QuestionPlanInput;
  interview_turn: InterviewTurnInput;
  coding_task_selection: CodingTaskSelectionInput;
  answer_evaluation: AnswerEvaluationInput;
  communication_evaluation: CommunicationEvaluationInput;
  code_review: CodeReviewInput;
}

/**
 * One adapter per capability. `run` returns the provider's raw output; validation, timeouts,
 * consent checks, retries and logging are applied uniformly by `invokeCapability`.
 */
export interface CapabilityAdapter<C extends AiCapability = AiCapability> {
  readonly descriptor: ProviderDescriptor & { capability: C };
  run(input: CapabilityInputs[C], ctx: CallContext): Promise<AdapterOutput>;
}
