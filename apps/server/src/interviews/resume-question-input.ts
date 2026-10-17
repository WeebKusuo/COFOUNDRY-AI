import {
  INTERVIEW_CONTRACT_VERSION,
  QUESTION_GENERATION_LIMITS as Q,
  ROLE_KEY,
  redactContactDetails,
  type InterviewResumeBinding,
  type RequiredSkill,
  type ResumeQuestionGenerationInput,
  type SkillEntry,
  type SkillId,
} from '@cofoundry/shared';
import type { ResumeInterviewMaterial, ResumeService } from '../resumes/service.js';

/**
 * Integration point for resume-based interview question generation (later phases).
 *
 * The future interview service calls `resolveResumeBinding` when an invitation is accepted and
 * stores the result on the session; if the binding is `profile_only`, no resume-based questions
 * are generated. `buildResumeQuestionInput` produces the only payload sent to the question
 * generator: redacted resume text, self-reported skills/projects and the role's required skills.
 * It never includes user ids, names, contact details, links or the brief's problem/solution.
 */

export async function resolveResumeBinding(
  resumes: ResumeService,
  candidateUserId: string,
): Promise<{ binding: InterviewResumeBinding; material: ResumeInterviewMaterial | null }> {
  const result = await resumes.readForInterviewProcessing(candidateUserId);
  if (!result.ready) {
    const reason =
      result.reason === 'no_text' || result.reason === 'consent_missing'
        ? result.reason
        : 'no_resume';
    return { binding: { mode: 'profile_only', resumeRef: null, reason }, material: null };
  }
  return {
    binding: { mode: 'resume_based', resumeRef: result.material.ref },
    material: result.material,
  };
}

export interface QuestionInputSources {
  material: ResumeInterviewMaterial;
  profile: {
    skills: readonly SkillEntry[];
    projects: ReadonlyArray<{ title: string; description: string; skillTags: readonly SkillId[] }>;
  };
  requiredSkills: readonly RequiredSkill[];
  questionCount: number;
}

export function buildResumeQuestionInput(src: QuestionInputSources): ResumeQuestionGenerationInput {
  const count = Math.trunc(src.questionCount);
  if (count < Q.questionCountMin || count > Q.questionCountMax) {
    throw new RangeError(`questionCount must be ${Q.questionCountMin}-${Q.questionCountMax}`);
  }
  const text = Array.from(src.material.redactedText);
  return {
    contractVersion: INTERVIEW_CONTRACT_VERSION,
    roleKey: ROLE_KEY,
    language: 'en',
    resume: {
      ref: { ...src.material.ref },
      redactedText: text.slice(0, Q.resumeTextMaxChars).join(''),
      truncated: src.material.truncated || text.length > Q.resumeTextMaxChars,
    },
    profile: {
      skills: src.profile.skills.map((s) => ({ skillId: s.skillId, level: s.level })),
      // Self-reported text, redacted like the resume; project links are deliberately omitted.
      projects: src.profile.projects.map((p) => ({
        title: redactContactDetails(p.title).text,
        description: redactContactDetails(p.description).text,
        skillTags: [...p.skillTags],
      })),
    },
    brief: {
      requiredSkills: src.requiredSkills.map((s) => ({
        skillId: s.skillId,
        level: s.level,
        importance: s.importance,
      })),
    },
    constraints: { questionCount: count, maxQuestionChars: Q.questionMaxChars },
  };
}
