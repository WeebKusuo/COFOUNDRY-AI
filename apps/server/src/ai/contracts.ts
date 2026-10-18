import { z } from 'zod';
import {
  ANSWER_SIGNALS,
  CODE_REVIEW_DIMENSIONS,
  COMMUNICATION_DIMENSIONS,
  INTERVIEW_LIMITS,
  QUESTION_TYPES,
  SKILL_IDS,
  TECHNICAL_DIMENSIONS,
  TURN_INTENTS,
} from '@cofoundry/shared';
import type {
  CodingTaskSelectionInput,
  InterviewTurnInput,
  InterviewTurnOutput,
  QuestionPlanInput,
  QuestionPlanOutput,
  ResumeContext,
} from './types.js';

/**
 * Strict output schemas (contract ai-interview-contract-v2). Provider output is validated with
 * these through invokeCapability; anything that does not match is `invalid_output` — never
 * repaired or clamped. Semantic checks (evidence quotes, interview policy) follow below.
 */

const skill = z.enum(SKILL_IDS);
const shortText = (max: number) => z.string().trim().min(1).max(max);
const level = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.null(),
]);

export const resumeContextSchema = z.strictObject({
  skills: z.array(shortText(60)).max(30),
  projects: z
    .array(
      z.strictObject({
        name: shortText(120),
        summary: shortText(400),
        technologies: z.array(shortText(60)).max(12),
        contributions: z.array(shortText(240)).max(6),
        evidence: shortText(300),
      }),
    )
    .max(8),
  experience: z.array(z.strictObject({ summary: shortText(300), evidence: shortText(300) })).max(8),
  achievements: z.array(z.strictObject({ text: shortText(240), evidence: shortText(300) })).max(8),
}) satisfies z.ZodType<ResumeContext>;

export const turnQuestionSchema = z.strictObject({
  type: z.enum(QUESTION_TYPES),
  topic: shortText(80),
  intent: z.enum(TURN_INTENTS),
  difficulty: z.number().int().min(1).max(5),
  prompt: z.string().trim().min(15).max(INTERVIEW_LIMITS.questionMaxChars),
  targetSkills: z.array(skill).max(4),
  resumeEvidence: z.string().trim().min(10).max(300).nullable(),
  followsUp: z.number().int().min(0).nullable(),
  expectedConcepts: z.array(shortText(160)).min(1).max(6),
});

export const plannedQuestionSchema = z.strictObject({
  slot: z.number().int().min(0),
  type: z.enum(QUESTION_TYPES),
  topic: shortText(80),
  difficulty: z.number().int().min(1).max(5),
  prompt: z.string().trim().min(15).max(INTERVIEW_LIMITS.questionMaxChars),
  targetSkills: z.array(skill).max(4),
  resumeEvidence: z.string().trim().min(10).max(300).nullable(),
  expectedConcepts: z.array(shortText(160)).min(1).max(6),
});

export const questionPlanOutputSchema = z.strictObject({
  questions: z.array(plannedQuestionSchema).min(1).max(12),
}) satisfies z.ZodType<QuestionPlanOutput>;

export const interviewTurnOutputSchema = z.strictObject({
  assessment: z.strictObject({ signal: z.enum(ANSWER_SIGNALS), note: z.string().max(300) }),
  decision: z.enum(['ask', 'end']),
  question: turnQuestionSchema.nullable(),
}) satisfies z.ZodType<InterviewTurnOutput>;

export const codingTaskSelectionSchema = z.strictObject({
  taskId: shortText(60),
  reason: shortText(300),
});

const judgment = (evidenceMax: number) =>
  z.strictObject({
    level,
    rationale: z.string().trim().max(400),
    evidence: z.array(z.string().trim().min(3).max(evidenceMax)).max(3),
  });

function dimensionObject<D extends string>(dims: readonly D[], evidenceMax: number) {
  const shape = Object.fromEntries(dims.map((d) => [d, judgment(evidenceMax)])) as Record<
    D,
    ReturnType<typeof judgment>
  >;
  return z.strictObject(shape);
}

export const answerEvaluationSchema = z.strictObject({
  dimensions: dimensionObject(TECHNICAL_DIMENSIONS, 240),
  conceptsDemonstrated: z.array(shortText(160)).max(8),
  conceptsMissing: z.array(shortText(160)).max(8),
  incorrectStatements: z
    .array(z.strictObject({ quote: z.string().trim().min(3).max(240), issue: shortText(300) }))
    .max(5),
  strengths: z
    .array(z.strictObject({ point: shortText(240), evidence: z.string().trim().min(3).max(240) }))
    .max(5),
  gaps: z
    .array(
      z.strictObject({ point: shortText(240), kind: z.enum(['incorrect', 'missing_evidence']) }),
    )
    .max(6),
  uncertainty: z.strictObject({
    level: z.enum(['low', 'medium', 'high']),
    reasons: z.array(shortText(240)).max(4),
  }),
  transcriptionIssuesSuspected: z.boolean(),
});
export type AnswerEvaluationOutput = z.infer<typeof answerEvaluationSchema>;

export const communicationEvaluationSchema = z.strictObject({
  dimensions: dimensionObject(COMMUNICATION_DIMENSIONS, 240),
  overallFeedback: shortText(800),
  strengths: z.array(shortText(240)).max(5),
  suggestions: z.array(shortText(240)).max(5),
});
export type CommunicationEvaluationOutput = z.infer<typeof communicationEvaluationSchema>;

export const codeReviewSchema = z.strictObject({
  dimensions: dimensionObject(CODE_REVIEW_DIMENSIONS, 300),
  explanationFeedback: z.string().trim().max(600),
  improvements: z.array(shortText(300)).max(6),
  issues: z
    .array(z.strictObject({ line: z.number().int().min(1).nullable(), comment: shortText(300) }))
    .max(8),
  summary: shortText(600),
});
export type CodeReviewOutput = z.infer<typeof codeReviewSchema>;

// --- Semantic checks ------------------------------------------------------------------------------

/** Whitespace- and case-insensitive containment, so line breaks in transcripts do not matter. */
export function normalizeForQuote(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A quote counts as evidence only when it is verbatim AND substantial: at least 12 characters,
 * or at least 3 words and 8 characters, or the entire (short) source. A model cannot back a
 * judgment with "the" or "and".
 */
export function isQuoteOf(quote: string, source: string): boolean {
  const q = normalizeForQuote(quote);
  const src = normalizeForQuote(source);
  if (q.length < 3 || !src.includes(q)) return false;
  return q.length >= 12 || (q.split(' ').length >= 3 && q.length >= 8) || q === src;
}

/**
 * Keep only resume-context items whose evidence is an exact quote of the redacted resume text.
 * Guards against invented resume claims; it does not prove the summary is accurate.
 */
export function filterResumeContext(ctx: ResumeContext, resumeText: string): ResumeContext {
  return {
    skills: ctx.skills,
    projects: ctx.projects.filter((p) => isQuoteOf(p.evidence, resumeText)),
    experience: ctx.experience.filter((e) => isQuoteOf(e.evidence, resumeText)),
    achievements: ctx.achievements.filter((a) => isQuoteOf(a.evidence, resumeText)),
  };
}

/** Token-set similarity used to reject repeated questions. */
export function promptSimilarity(a: string, b: string): number {
  const tokens = (s: string) =>
    new Set(
      normalizeForQuote(s)
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(' ')
        .filter((t) => t.length > 2),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

export const REPEAT_SIMILARITY_THRESHOLD = 0.75;

/**
 * Interview policy checks on a generated turn (Phase 8). Returns a reason (no candidate content)
 * or null. The server, not the model, decides depth limits, coverage and when the conversation
 * may end; the model must follow the supplied policy.
 */
export function checkTurnPolicy(
  output: InterviewTurnOutput,
  input: Pick<InterviewTurnInput, 'policy' | 'history' | 'lastAnswerIndex' | 'candidate'>,
  resumeText: string,
): string | null {
  const { policy } = input;
  if (output.decision === 'end') {
    if (!policy.mayEnd) return 'decision_end_not_allowed';
    return output.question === null ? null : 'end_with_question';
  }
  const q = output.question;
  if (!q) return 'missing_question';
  if (q.difficulty < policy.difficultyMin || q.difficulty > policy.difficultyMax) {
    return 'difficulty_out_of_range';
  }
  const last = input.history.find((h) => h.index === input.lastAnswerIndex);
  if (q.followsUp === null) {
    if (q.intent !== 'new_topic') return 'new_topic_intent_required';
    if (q.type !== policy.newTopicType) return 'unexpected_question_type';
    const topic = normalizeForQuote(q.topic);
    if (policy.coveredTopics.some((t) => normalizeForQuote(t) === topic)) {
      return 'topic_already_covered';
    }
  } else {
    if (policy.mustChangeTopic) return 'follow_up_not_allowed';
    if (!last || q.followsUp !== last.index) return 'follow_up_must_reference_last_answer';
    if (q.intent !== policy.intentForSignal[output.assessment.signal]) {
      return 'intent_does_not_match_policy';
    }
  }
  // A new resume-project topic must quote the resume; follow-ups inherit their parent's quote,
  // and any quote that is given must still be real.
  if (q.type === 'resume_project' && q.followsUp === null && !q.resumeEvidence) {
    return 'resume_evidence_not_in_resume';
  }
  if (q.resumeEvidence && !isQuoteOf(q.resumeEvidence, resumeText)) {
    return 'resume_evidence_not_in_resume';
  }
  for (const h of input.history) {
    if (promptSimilarity(h.prompt, q.prompt) >= REPEAT_SIMILARITY_THRESHOLD) {
      return 'repeated_question';
    }
  }
  return null;
}

/**
 * Question-plan checks: exactly one question per slot, in order, with the slot's type and
 * difficulty range; distinct topics and prompts; resume_project questions quote the resume, and
 * any quote given is verbatim. Returns a reason (no candidate content) or null.
 */
export function checkQuestionPlan(
  output: QuestionPlanOutput,
  input: Pick<QuestionPlanInput, 'slots'>,
  resumeText: string,
): string | null {
  const qs = output.questions;
  if (qs.length !== input.slots.length) return 'wrong_question_count';
  const topics = new Set<string>();
  for (let i = 0; i < qs.length; i += 1) {
    const q = qs[i]!;
    const slot = input.slots[i]!;
    if (q.slot !== slot.slot || q.type !== slot.type) return 'slot_mismatch';
    if (q.difficulty < slot.difficultyMin || q.difficulty > slot.difficultyMax) {
      return 'difficulty_out_of_range';
    }
    if (q.type === 'resume_project' && !q.resumeEvidence) return 'resume_evidence_not_in_resume';
    if (q.resumeEvidence && !isQuoteOf(q.resumeEvidence, resumeText)) {
      return 'resume_evidence_not_in_resume';
    }
    const topic = normalizeForQuote(q.topic);
    if (topics.has(topic)) return 'duplicate_topic';
    topics.add(topic);
    for (let j = 0; j < i; j += 1) {
      if (promptSimilarity(qs[j]!.prompt, q.prompt) >= REPEAT_SIMILARITY_THRESHOLD) {
        return 'repeated_question';
      }
    }
  }
  return null;
}

export function checkTaskSelection(
  output: { taskId: string },
  input: Pick<CodingTaskSelectionInput, 'tasks'>,
): string | null {
  return input.tasks.some((t) => t.id === output.taskId) ? null : 'unknown_task';
}

/**
 * Evidence rule for judgments: drop quotes that are not in the source; a level that is left
 * without any supporting quote becomes null (insufficient evidence) — never a guess. Returns the
 * cleaned judgments and how many were downgraded.
 */
export function enforceEvidence<D extends string>(
  dims: Record<D, { level: number | null; rationale: string; evidence: string[] }>,
  source: string,
): {
  dims: Record<D, { level: number | null; rationale: string; evidence: string[] }>;
  downgraded: D[];
} {
  const out = {} as Record<D, { level: number | null; rationale: string; evidence: string[] }>;
  const downgraded: D[] = [];
  for (const key of Object.keys(dims) as D[]) {
    const j = dims[key];
    const evidence = j.evidence.filter((e) => isQuoteOf(e, source));
    if (j.level !== null && evidence.length === 0) {
      downgraded.push(key);
      out[key] = {
        level: null,
        rationale: 'Insufficient quoted evidence to support a level.',
        evidence: [],
      };
    } else {
      out[key] = { level: j.level, rationale: j.rationale, evidence };
    }
  }
  return { dims: out, downgraded };
}
