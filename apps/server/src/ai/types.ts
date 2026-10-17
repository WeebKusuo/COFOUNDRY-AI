/**
 * AI provider architecture — capability ports (Phase 1: architecture only, no model calls).
 *
 * Every AI feature is a *capability* behind a small port interface. Adapters implement ports for a
 * concrete model/API (the AI team's fine-tuned service, an external LLM, a speech API ...), so a
 * model can be swapped by configuration without touching business logic.
 *
 * Rules that hold for every capability (Contract Sections 09, 10, 23, 24):
 *  - Adapters receive only the minimum data: no user IDs, emails, phone numbers, contact fields or
 *    full startup ideas. Candidate text is passed as delimited *data*, never as instructions.
 *  - Adapters return raw structured judgments; the backend validates them strictly (no clamping)
 *    and computes every total itself.
 *  - Technical scores, language feedback and observable presentation signals are separate outputs
 *    and are never merged into one number.
 *  - Credentials stay server-side; only metadata (provider, model, latency, tokens, error code) is
 *    logged — never prompts, answers or media.
 *
 * The input/output shapes below are DRAFTS. The updated AI interview contract supersedes them
 * before the interview phases; change them there together with their tests.
 */

export const AI_CAPABILITIES = [
  'question_generation',
  'technical_evaluation',
  'language_evaluation',
  'speech_analysis',
  'video_signals',
  'cross_validation',
] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];

/** Capabilities that process audio/video and therefore need explicit media consent. */
export const MEDIA_CAPABILITIES: ReadonlySet<AiCapability> = new Set([
  'speech_analysis',
  'video_signals',
]);

/**
 * Server-side provider settings (from LLM_PROVIDER / LLM_MODEL / LLM_API_KEY). Declared here so
 * the AI module has no dependency on the rest of the server; config.LlmConfig is compatible.
 */
export interface AiProviderSettings {
  provider: string;
  model: string | null;
  apiKey: string | null;
}

/** The subset of the pino logger the AI module uses (metadata only — never payloads). */
export interface AiLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export type ProviderErrorCode =
  'disabled' | 'timeout' | 'cancelled' | 'upstream_failed' | 'invalid_output' | 'consent_missing';

export interface ProviderDescriptor {
  capability: AiCapability;
  /** Stable provider label, e.g. "disabled", "cofoundry-qgen", "openai". */
  providerId: string;
  /** Exact model identifier recorded on every stored artefact; null when disabled. */
  model: string | null;
  /** Adapter version — bump when prompt/parsing behaviour changes (Section 10). */
  adapterVersion: string;
}

export interface CallMeta {
  providerId: string;
  model: string | null;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

export type ProviderResult<T> =
  | { ok: true; value: T; meta: CallMeta }
  | { ok: false; error: { code: ProviderErrorCode; message: string }; meta: CallMeta };

/** Proof that the participant granted consent for this purpose (stored ConsentRecord). */
export interface ConsentProof {
  purpose: 'assessment' | 'interview_audio' | 'interview_video';
  consentRecordId: string;
  policyVersion: string;
}

export interface CallContext {
  signal: AbortSignal;
  /** Required for MEDIA_CAPABILITIES; checked before any adapter is called. */
  consent?: ConsentProof;
}

/** Raw adapter output plus optional token usage reported by the provider. */
export interface AdapterOutput {
  output: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
}

// ---------------------------------------------------------------------------------------------
// Draft capability inputs. Outputs are validated with zod schemas owned by each phase.
// ---------------------------------------------------------------------------------------------

/** Question generation / cross-questioning (AI team's fine-tuned model). */
export interface QuestionGenerationInput {
  roleKey: string;
  /** Candidate-approved, PII-stripped resume/profile summary. */
  profileSummary: string;
  /** Earlier question/answer pairs in this session, oldest first. */
  history: Array<{ questionId: string; question: string; answer: string }>;
  /** What to generate next. */
  kind: 'next_question' | 'follow_up';
  sourceQuestionId?: string;
}

/** Technical evaluation of one answer against a fixed question and rubric. */
export interface TechnicalEvaluationInput {
  questionId: string;
  question: string;
  rubricVersion: string;
  /** Hidden expected points — service-side only, never sent to browsers. */
  expectedPoints: string[];
  answer: string;
}

/** Language detection and communication feedback — kept separate from technical scores. */
export interface LanguageEvaluationInput {
  answer: string;
}

/** Speech transcription. Pace and pause metrics are computed deterministically by the backend. */
export interface SpeechAnalysisInput {
  audio: { mimeType: string; durationMs: number; bytes: Uint8Array };
  languageHint?: 'en' | 'hi';
}

/** Video analysis may report ONLY observable events — never cheating, confidence or emotion. */
export const OBSERVABLE_VIDEO_EVENTS = [
  'face_visible',
  'face_not_visible',
  'multiple_faces',
  'gaze_off_screen',
  'camera_interrupted',
] as const;
export type ObservableVideoEvent = (typeof OBSERVABLE_VIDEO_EVENTS)[number];

export interface VideoSignalsInput {
  /** Sampled frames or a provider-specific clip reference, never stored by the adapter. */
  frames: Array<{ atMs: number; mimeType: string; bytes: Uint8Array }>;
}

/** Cross-validation logic supplied by the AI team (e.g. consistency of claims across answers). */
export interface CrossValidationInput {
  items: Array<{ questionId: string; answer: string }>;
}

export interface CapabilityInputs {
  question_generation: QuestionGenerationInput;
  technical_evaluation: TechnicalEvaluationInput;
  language_evaluation: LanguageEvaluationInput;
  speech_analysis: SpeechAnalysisInput;
  video_signals: VideoSignalsInput;
  cross_validation: CrossValidationInput;
}

/**
 * One adapter per capability. `run` returns the provider's raw output; validation, timeouts,
 * consent checks and logging are applied uniformly by `invokeCapability`.
 */
export interface CapabilityAdapter<C extends AiCapability = AiCapability> {
  readonly descriptor: ProviderDescriptor & { capability: C };
  run(input: CapabilityInputs[C], ctx: CallContext): Promise<AdapterOutput>;
}
