import { z } from 'zod';
import {
  QUESTION_GENERATION_LIMITS as Q,
  SKILL_IDS,
  type FollowUpGenerationOutput,
  type GeneratedQuestion,
  type ResumeQuestionGenerationInput,
  type ResumeQuestionGenerationOutput,
} from '@cofoundry/shared';

/**
 * Strict output schemas for the user's fine-tuned question-generation and follow-up APIs
 * (contract ai-interview-contract-v1). Provider output is validated with these through
 * invokeCapability; anything that does not match is `invalid_output` — never repaired.
 */

const skill = z.enum(SKILL_IDS);

export const generatedQuestionSchema = z.strictObject({
  id: z.string().min(1).max(20),
  prompt: z.string().min(10).max(Q.questionMaxChars),
  targetSkills: z.array(skill).min(1).max(4),
  // A meaningful quote, not a single character that trivially appears in any resume.
  resumeEvidence: z.string().min(Q.evidenceQuoteMinChars).max(Q.evidenceQuoteMaxChars),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
}) satisfies z.ZodType<GeneratedQuestion>;

export const questionGenerationOutputSchema = z.strictObject({
  questions: z.array(generatedQuestionSchema).min(Q.questionCountMin).max(Q.questionCountMax),
}) satisfies z.ZodType<ResumeQuestionGenerationOutput>;

export const followUpOutputSchema = z.strictObject({
  followUp: z
    .strictObject({
      prompt: z.string().min(10).max(Q.questionMaxChars),
      targetSkills: z.array(skill).min(1).max(4),
    })
    .nullable(),
}) satisfies z.ZodType<FollowUpGenerationOutput>;

export interface EvidenceCheck {
  accepted: GeneratedQuestion[];
  rejected: Array<{
    question: GeneratedQuestion;
    reason: 'evidence_not_in_resume' | 'duplicate_id';
  }>;
}

/**
 * Section 23 evidence rule applied to generated questions: each question must quote an exact
 * substring of the redacted resume text it was given, and ids must be unique. This guards
 * against invented resume claims; it does not prove a question is good.
 */
export function checkQuestionEvidence(
  output: ResumeQuestionGenerationOutput,
  input: Pick<ResumeQuestionGenerationInput, 'resume'>,
): EvidenceCheck {
  const seen = new Set<string>();
  const result: EvidenceCheck = { accepted: [], rejected: [] };
  for (const question of output.questions) {
    if (seen.has(question.id)) {
      result.rejected.push({ question, reason: 'duplicate_id' });
      continue;
    }
    seen.add(question.id);
    if (!input.resume.redactedText.includes(question.resumeEvidence)) {
      result.rejected.push({ question, reason: 'evidence_not_in_resume' });
      continue;
    }
    result.accepted.push(question);
  }
  return result;
}
