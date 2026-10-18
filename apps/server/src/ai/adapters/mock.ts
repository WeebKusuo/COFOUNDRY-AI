import {
  CODE_REVIEW_DIMENSIONS,
  COMMUNICATION_DIMENSIONS,
  TECHNICAL_DIMENSIONS,
  type AnswerSignal,
} from '@cofoundry/shared';
import { PROMPT_VERSIONS } from '../prompts.js';
import {
  AI_CAPABILITIES,
  type AiCapability,
  type CapabilityAdapter,
  type CapabilityInputs,
  type InterviewTurnOutput,
  type QuestionPlanOutput,
  type ResumeContext,
} from '../types.js';

/**
 * Deterministic test double for every LLM capability — FOR AUTOMATED TESTS AND LOCAL E2E ONLY.
 * Configuration refuses LLM_PROVIDER=mock in production, and every stored artefact records
 * providerId "mock", so mock output can never pass for a real model's judgment.
 *
 * Outputs are simple functions of the input (keywords, lengths) so tests can assert behaviour;
 * they make no claim about answer quality.
 */

export const MOCK_MODEL = 'mock-deterministic-v1';

const TEMPLATES: Record<string, (topic: string) => string> = {
  background: () =>
    'To start, could you walk me through your background and the backend work you enjoy most?',
  fundamentals: (t) =>
    `Let us cover a fundamental: how does the Node.js event loop handle I/O, and where can it block? (${t})`,
  architecture: (t) =>
    `Thinking about architecture: how would you design a rate-limited REST API that stays reliable under load? (${t})`,
  problem_solving: (t) =>
    `Here is a practical problem: a production endpoint became slow after a release. How would you investigate it? (${t})`,
  scenario: (t) =>
    `Scenario: two requests update the same record at once and one change is lost. How would you prevent that? (${t})`,
};

const INTENT_TEMPLATES: Record<string, Array<(topic: string) => string>> = {
  go_deeper: [
    (t) => `Good. Going one level deeper on ${t}: what trade-offs did you weigh and why?`,
    (t) => `How would your approach to ${t} change if traffic grew tenfold overnight?`,
    (t) =>
      `What failure modes did you plan for in ${t}, and how would you detect them in production?`,
    (t) => `If you rebuilt ${t} today, which decision would you reverse first?`,
    (t) => `Which metric would tell you that ${t} is degrading before users notice?`,
  ],
  implementation_detail: [
    (t) =>
      `You mentioned ${t}. Which parts did you implement yourself, and how exactly did they work?`,
    (t) => `Walk me through the data model and the main code path you wrote for ${t}.`,
    (t) => `How did you test ${t}, and which bug was the hardest to find?`,
    (t) =>
      `Which library or framework choices in ${t} were yours, and what alternatives did you reject?`,
    (t) => `Describe one pull request you wrote for ${t} and what reviewers asked you to change.`,
  ],
  focused_follow_up: [
    (t) => `On ${t}, which part of your answer would you expand on to make it complete?`,
  ],
  request_example: [
    (t) => `Could you give a concrete example from your own work that illustrates ${t}?`,
  ],
  check_understanding: [
    (t) =>
      `Let us check one detail about ${t}: what would actually happen in that case, step by step?`,
  ],
  clarify: [
    (t) => `Some of that audio was unclear. Could you briefly repeat the key points about ${t}?`,
  ],
};

function readSignal(answer: string | null, skipped: boolean): AnswerSignal {
  if (skipped || answer === null) return 'no_answer';
  if (answer.includes('[unclear audio]')) return 'unclear_audio';
  if (/\bwrong\b|\bnot sure\b|\bno idea\b/i.test(answer)) return 'incorrect';
  if (answer.length < 60) return 'vague';
  return /\bbecause\b|\bfor example\b|\btrade-?off\b/i.test(answer) ? 'strong' : 'partial';
}

function firstSentence(text: string, max = 200): string {
  const trimmed = text.trim();
  const end = trimmed.search(/[.!?](\s|$)/);
  const sentence = end > 0 ? trimmed.slice(0, end + 1) : trimmed;
  return Array.from(sentence).slice(0, max).join('');
}

function resumeContext(text: string): ResumeContext {
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 20);
  const projects = lines
    .filter((l) => /\b(built|developed|implemented|designed|created|led|wrote)\b/i.test(l))
    .slice(0, 4)
    .map((l, i) => {
      const evidence = Array.from(l).slice(0, 160).join('');
      return {
        name: `Project ${i + 1}`,
        summary: evidence,
        technologies: [],
        contributions: [evidence],
        evidence,
      };
    });
  const skills = ['Node.js', 'TypeScript', 'MongoDB', 'REST', 'Docker'].filter((s) =>
    text.toLowerCase().includes(s.toLowerCase().replace('.js', '')),
  );
  return { skills, projects, experience: [], achievements: [] };
}

/** One question per slot; resume_project slots quote a different resume project each. */
function questionPlan(input: CapabilityInputs['question_plan']): QuestionPlanOutput {
  const projects = input.candidate.resumeContext.projects;
  let nextProject = 0;
  return {
    questions: input.slots.map((slot) => {
      const topic = `${slot.type.replace('_', ' ')} plan ${slot.slot + 1}`;
      const difficulty = slot.difficultyMin;
      if (slot.type === 'resume_project') {
        const occurrence = nextProject;
        const project = projects[occurrence % Math.max(1, projects.length)];
        nextProject += 1;
        const evidence = project?.evidence ?? null;
        const quote = evidence?.slice(0, 80) ?? 'a project';
        // A one-project resume gets a different angle on the same project each time.
        const prompt =
          occurrence % 2 === 0
            ? `Your resume says: "${quote}". What did you build yourself there, and how did it work? (${topic})`
            : `Looking again at "${quote}": which decision there was hardest, which alternatives did you reject, and why? (${topic})`;
        return {
          slot: slot.slot,
          type: slot.type,
          topic,
          difficulty,
          prompt,
          targetSkills: [],
          resumeEvidence: evidence,
          expectedConcepts: ['own contribution', 'implementation detail'],
        };
      }
      const make = TEMPLATES[slot.type] ?? TEMPLATES.fundamentals!;
      return {
        slot: slot.slot,
        type: slot.type,
        topic,
        difficulty,
        prompt: make(topic),
        targetSkills: [],
        resumeEvidence: null,
        expectedConcepts: ['core concept', 'trade-offs'],
      };
    }),
  };
}

function interviewTurn(input: CapabilityInputs['interview_turn']): InterviewTurnOutput {
  const { policy } = input;
  const last = input.history.find((h) => h.index === input.lastAnswerIndex) ?? null;
  const signal: AnswerSignal = last
    ? readSignal(last.answer, last.answerStatus === 'skipped')
    : 'not_applicable';
  if (policy.mayEnd && policy.remainingQuestions <= 0) {
    return { assessment: { signal, note: 'mock' }, decision: 'end', question: null };
  }
  const difficulty = Math.min(policy.difficultyMax, Math.max(policy.difficultyMin, 2));
  const followUp =
    last !== null &&
    !policy.mustChangeTopic &&
    last.answerStatus === 'answered' &&
    signal !== 'not_applicable' &&
    signal !== 'no_answer';
  if (followUp) {
    const intent = policy.intentForSignal[signal];
    const variants = INTENT_TEMPLATES[intent] ?? INTENT_TEMPLATES.focused_follow_up!;
    const used = input.history.filter((h) => h.intent === intent).length;
    const make = variants[used % variants.length]!;
    return {
      assessment: { signal, note: 'mock' },
      decision: 'ask',
      question: {
        type: last.questionType,
        topic: last.topic,
        intent,
        difficulty,
        prompt: make(last.topic),
        targetSkills: [],
        resumeEvidence: null,
        followsUp: last.index,
        expectedConcepts: ['trade-offs', 'concrete example'],
      },
    };
  }
  if (input.plannedNext) {
    return {
      assessment: { signal, note: 'mock' },
      decision: 'ask',
      question: {
        type: input.plannedNext.type,
        topic: input.plannedNext.topic,
        intent: 'new_topic',
        difficulty,
        prompt: input.plannedNext.prompt,
        targetSkills: [],
        resumeEvidence: null,
        followsUp: null,
        expectedConcepts: ['core concept'],
      },
    };
  }
  const type = policy.newTopicType;
  const n = input.history.length + 1;
  const topic = `${type.replace('_', ' ')} ${n}`;
  if (type === 'resume_project') {
    const used = new Set(input.history.map((h) => h.prompt));
    const project =
      input.candidate.resumeContext.projects.find(
        (p) => ![...used].some((u) => u.includes(p.evidence.slice(0, 40))),
      ) ?? input.candidate.resumeContext.projects[0];
    const evidence = project?.evidence ?? null;
    return {
      assessment: { signal, note: 'mock' },
      decision: 'ask',
      question: {
        type,
        topic,
        intent: 'new_topic',
        difficulty,
        prompt: `Your resume says: "${evidence?.slice(0, 80) ?? 'a project'}". What was your own contribution, and how did you build it? (${topic})`,
        targetSkills: [],
        resumeEvidence: evidence,
        followsUp: null,
        expectedConcepts: ['own contribution', 'implementation detail'],
      },
    };
  }
  const make = TEMPLATES[type] ?? TEMPLATES.fundamentals!;
  return {
    assessment: { signal, note: 'mock' },
    decision: 'ask',
    question: {
      type,
      topic,
      intent: 'new_topic',
      difficulty,
      prompt: make(topic),
      targetSkills: [],
      resumeEvidence: null,
      followsUp: null,
      expectedConcepts: ['core concept', 'trade-offs'],
    },
  };
}

function levelsFor(text: string): number {
  if (text.trim().length === 0) return 0;
  if (/\bbecause\b/i.test(text) && text.length > 120) return 3;
  return text.length > 60 ? 2 : 1;
}

const OUTPUTS: { [C in AiCapability]: (input: CapabilityInputs[C]) => unknown } = {
  resume_context: (input) => resumeContext(input.resumeText),
  question_plan: questionPlan,
  interview_turn: interviewTurn,
  coding_task_selection: (input) => {
    const role = new Set(input.roleSkills);
    const ranked = [...input.tasks].sort(
      (a, b) =>
        b.skills.filter((s) => role.has(s)).length - a.skills.filter((s) => role.has(s)).length ||
        a.id.localeCompare(b.id),
    );
    return {
      taskId: ranked[0]!.id,
      reason: 'Matches the role skills (deterministic test choice).',
    };
  },
  answer_evaluation: (input) => {
    const quote = firstSentence(input.answer.text);
    const level = levelsFor(input.answer.text);
    const dims = Object.fromEntries(
      TECHNICAL_DIMENSIONS.map((d) => [
        d,
        quote.length >= 3
          ? { level, rationale: 'mock judgment', evidence: [quote] }
          : { level: null, rationale: 'no evidence', evidence: [] },
      ]),
    );
    return {
      dimensions: dims,
      conceptsDemonstrated: level >= 3 ? ['reasoning'] : [],
      conceptsMissing: level < 3 ? ['trade-offs'] : [],
      incorrectStatements: [],
      strengths:
        level >= 3 && quote.length >= 3 ? [{ point: 'Explains reasoning', evidence: quote }] : [],
      gaps: level < 3 ? [{ point: 'Could discuss trade-offs', kind: 'missing_evidence' }] : [],
      uncertainty: {
        level: input.answer.transcriptConfidence === 'low' ? 'high' : 'low',
        reasons: input.answer.transcriptConfidence === 'low' ? ['Low transcript confidence'] : [],
      },
      transcriptionIssuesSuspected: input.answer.text.includes('[unclear audio]'),
    };
  },
  communication_evaluation: (input) => {
    const quote = firstSentence(input.answers[0]?.text ?? '');
    const dims = Object.fromEntries(
      COMMUNICATION_DIMENSIONS.map((d) => [
        d,
        quote.length >= 3
          ? { level: 3, rationale: 'mock judgment', evidence: [quote] }
          : { level: null, rationale: 'no evidence', evidence: [] },
      ]),
    );
    return {
      dimensions: dims,
      overallFeedback: 'Mock communication feedback for automated tests.',
      strengths: ['Answers were understandable.'],
      suggestions: ['Structure answers as context, approach, result.'],
    };
  },
  code_review: (input) => {
    const firstLine =
      input.code
        .split('\n')
        .find((l) => l.trim().length >= 3)
        ?.trim() ?? '';
    const dims = Object.fromEntries(
      CODE_REVIEW_DIMENSIONS.map((d) => [
        d,
        firstLine
          ? { level: 3, rationale: 'mock review', evidence: [firstLine.slice(0, 200)] }
          : { level: null, rationale: 'no code', evidence: [] },
      ]),
    );
    return {
      dimensions: dims,
      explanationFeedback: input.explanation ? 'Explanation present.' : 'No explanation given.',
      improvements: ['Add input validation.'],
      issues: [],
      summary: 'Mock code review for automated tests.',
    };
  },
};

export function createMockAdapters(): { [C in AiCapability]: CapabilityAdapter<C> } {
  const make = <C extends AiCapability>(capability: C): CapabilityAdapter<C> => ({
    descriptor: {
      capability,
      providerId: 'mock',
      model: MOCK_MODEL,
      adapterVersion: 'mock-v1',
      promptVersion: PROMPT_VERSIONS[capability],
    },
    run: async (input) => ({ output: structuredClone(OUTPUTS[capability](input)) }),
  });
  return Object.fromEntries(AI_CAPABILITIES.map((c) => [c, make(c)])) as {
    [C in AiCapability]: CapabilityAdapter<C>;
  };
}
