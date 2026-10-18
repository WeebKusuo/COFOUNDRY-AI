import { describe, expect, it } from 'vitest';
import {
  answerEvaluationSchema,
  checkQuestionPlan,
  checkTurnPolicy,
  enforceEvidence,
  filterResumeContext,
  interviewTurnOutputSchema,
  isQuoteOf,
  promptSimilarity,
  questionPlanOutputSchema,
  type InterviewTurnInput,
  type InterviewTurnOutput,
} from '../../src/ai/index.js';
import {
  computeTurnPolicy,
  intentForSignal,
  questionPlanSlots,
} from '../../src/interviews/policy.js';
import type { TurnRecord } from '../../src/interviews/records.js';

const RESUME =
  'Built a payment reconciliation REST API in Node.js and MongoDB.\nImplemented idempotent webhooks.';

function turn(index: number, over: Partial<TurnRecord> = {}): TurnRecord {
  return {
    index,
    kind: 'question',
    questionType: 'fundamentals',
    topic: `topic ${index}`,
    intent: 'new_topic',
    difficulty: 2,
    prompt: `Question number ${index} about something different ${'x'.repeat(index)}`,
    parentIndex: null,
    resumeEvidence: null,
    targetSkills: [],
    expectedConcepts: ['a'],
    askedAt: '2026-10-17T10:00:00.000Z',
    steeringSignal: null,
    generatedBy: null,
    draft: null,
    answer: {
      text: 'An answer because reasons and more reasons to be long enough for a test.',
      inputMode: 'typed',
      transcriptOriginal: null,
      transcriptConfidence: null,
      uncertainSegments: 0,
      edited: false,
      editRatio: null,
      skipped: false,
      skipReason: null,
      submittedAt: '2026-10-17T10:01:00.000Z',
      injectionSuspected: false,
    },
    ...over,
  };
}

const clock = {
  now: new Date('2026-10-17T10:05:00Z'),
  conversationDeadline: new Date('2026-10-17T10:25:00Z'),
};

function inputFor(turns: TurnRecord[]): InterviewTurnInput {
  const last = turns[turns.length - 1];
  return {
    contractVersion: 'ai-interview-contract-v2',
    roleKey: 'backend-node-v1',
    language: 'en',
    role: { requiredSkills: [] },
    candidate: {
      skills: [],
      resumeContext: { skills: [], projects: [], experience: [], achievements: [] },
    },
    history: turns.map((t) => ({
      index: t.index,
      questionType: t.questionType!,
      topic: t.topic!,
      intent: t.intent!,
      difficulty: t.difficulty!,
      prompt: t.prompt,
      answer: t.answer?.text ?? null,
      answerStatus: t.answer?.skipped ? 'skipped' : 'answered',
      inputMode: 'typed',
      transcriptConfidence: null,
    })),
    lastAnswerIndex: last?.index ?? null,
    policy: computeTurnPolicy(turns, clock),
    plannedNext: null,
  };
}

function output(
  q: Partial<NonNullable<InterviewTurnOutput['question']>>,
  signal: InterviewTurnOutput['assessment']['signal'] = 'strong',
): InterviewTurnOutput {
  return {
    assessment: { signal, note: '' },
    decision: 'ask',
    question: {
      type: 'fundamentals',
      topic: 'event loop',
      intent: 'new_topic',
      difficulty: 2,
      prompt: 'How does the Node.js event loop schedule timers versus I/O callbacks?',
      targetSkills: ['nodejs'],
      resumeEvidence: null,
      followsUp: null,
      expectedConcepts: ['phases'],
      ...q,
    },
  };
}

describe('interview turn policy (adaptive questioning rules)', () => {
  it('first question must open the background topic', () => {
    const input = inputFor([]);
    expect(input.policy.newTopicType).toBe('background');
    expect(input.policy.mustChangeTopic).toBe(true);
    expect(
      checkTurnPolicy(output({ type: 'background', topic: 'background' }), input, RESUME),
    ).toBeNull();
    expect(checkTurnPolicy(output({ type: 'fundamentals' }), input, RESUME)).toBe(
      'unexpected_question_type',
    );
  });

  it('requires the follow-up intent that matches the answer signal', () => {
    const turns = [turn(1, { questionType: 'background' })];
    const input = inputFor(turns);
    const follow = (
      intent: NonNullable<InterviewTurnOutput['question']>['intent'],
      signal: InterviewTurnOutput['assessment']['signal'],
    ) =>
      checkTurnPolicy(
        output({ type: 'background', topic: 'topic 1', intent, followsUp: 1 }, signal),
        input,
        RESUME,
      );
    expect(follow('go_deeper', 'strong')).toBeNull();
    expect(follow('focused_follow_up', 'partial')).toBeNull();
    expect(follow('request_example', 'vague')).toBeNull();
    expect(follow('check_understanding', 'incorrect')).toBeNull();
    expect(follow('clarify', 'unclear_audio')).toBeNull();
    expect(follow('go_deeper', 'vague')).toBe('intent_does_not_match_policy');
    expect(follow('go_deeper', 'strong')).toBeNull();
  });

  it('asks implementation detail after a strong answer about a resume project', () => {
    expect(intentForSignal(turn(1, { questionType: 'resume_project' })).strong).toBe(
      'implementation_detail',
    );
  });

  it('limits follow-up depth and forbids a second understanding check on the same topic', () => {
    const chain = [
      turn(1),
      turn(2, { parentIndex: 1, intent: 'go_deeper' }),
      turn(3, { parentIndex: 2, intent: 'go_deeper' }),
    ];
    const deep = inputFor(chain);
    expect(deep.policy.followUpDepth).toBe(2);
    expect(deep.policy.mustChangeTopic).toBe(true);
    expect(checkTurnPolicy(output({ followsUp: 3, intent: 'go_deeper' }), deep, RESUME)).toBe(
      'follow_up_not_allowed',
    );

    const checked = inputFor([turn(1), turn(2, { parentIndex: 1, intent: 'check_understanding' })]);
    expect(checked.policy.mustChangeTopic).toBe(true);
  });

  it('moves to a new topic after a skipped answer', () => {
    const skipped = turn(1, {
      answer: { ...turn(1).answer!, skipped: true, text: '', skipReason: 'manual_skip' },
    });
    expect(inputFor([skipped]).policy.mustChangeTopic).toBe(true);
  });

  it('rejects repeated questions and already covered topics', () => {
    const turns = [
      turn(1, {
        questionType: 'background',
        topic: 'background',
        prompt: 'How does the Node.js event loop schedule timers versus I/O callbacks?',
      }),
    ];
    const input = inputFor(turns);
    input.policy.mustChangeTopic = true;
    input.policy.newTopicType = 'fundamentals';
    expect(checkTurnPolicy(output({}), input, RESUME)).toBe('repeated_question');
    expect(
      checkTurnPolicy(
        output({
          topic: 'Background',
          prompt: 'A completely different question about indexing strategies?',
        }),
        input,
        RESUME,
      ),
    ).toBe('topic_already_covered');
  });

  it('requires resume project questions to quote the resume exactly', () => {
    const input = inputFor([turn(1, { questionType: 'background' })]);
    input.policy.mustChangeTopic = true;
    input.policy.newTopicType = 'resume_project';
    const ok = output({
      type: 'resume_project',
      topic: 'reconciliation',
      resumeEvidence: 'payment reconciliation REST API in Node.js',
      prompt: 'Walk me through the reconciliation API you built.',
    });
    expect(checkTurnPolicy(ok, input, RESUME)).toBeNull();
    const invented = output({
      type: 'resume_project',
      topic: 'reconciliation',
      resumeEvidence: 'led a team of 40 engineers at Google',
      prompt: 'Walk me through leading forty engineers.',
    });
    expect(checkTurnPolicy(invented, input, RESUME)).toBe('resume_evidence_not_in_resume');
  });

  it('only allows ending once enough questions were answered and coverage is met', () => {
    const end: InterviewTurnOutput = {
      assessment: { signal: 'strong', note: '' },
      decision: 'end',
      question: null,
    };
    expect(checkTurnPolicy(end, inputFor([turn(1)]), RESUME)).toBe('decision_end_not_allowed');
    const many = [
      'background',
      'resume_project',
      'fundamentals',
      'architecture',
      'problem_solving',
      'scenario',
    ].map((t, i) => turn(i + 1, { questionType: t as TurnRecord['questionType'] }));
    expect(checkTurnPolicy(end, inputFor(many), RESUME)).toBeNull();
  });

  it('keeps difficulty within one step of the previous question', () => {
    const input = inputFor([turn(1, { difficulty: 3 })]);
    expect([input.policy.difficultyMin, input.policy.difficultyMax]).toEqual([2, 4]);
    input.policy.mustChangeTopic = true;
    expect(
      checkTurnPolicy(output({ difficulty: 5, type: input.policy.newTopicType }), input, RESUME),
    ).toBe('difficulty_out_of_range');
  });
});

describe('output schemas and evidence', () => {
  it('rejects extra keys such as model-supplied totals', () => {
    const bad = { ...output({}), score: 99 };
    expect(interviewTurnOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('downgrades levels whose quotes are not in the answer to null (insufficient evidence)', () => {
    const answer = 'I would add an index on userId because the query filters by it.';
    const { dims, downgraded } = enforceEvidence(
      {
        correctness: { level: 4, rationale: 'r', evidence: ['add an index on userId'] },
        reasoning: { level: 4, rationale: 'r', evidence: ['I benchmarked it carefully'] },
      },
      answer,
    );
    expect(dims.correctness.level).toBe(4);
    expect(dims.reasoning).toMatchObject({ level: null, evidence: [] });
    expect(downgraded).toEqual(['reasoning']);
  });

  it('matches quotes regardless of whitespace and case but not paraphrases', () => {
    expect(isQuoteOf('ADD  an\nindex', 'I would add an index')).toBe(true);
    expect(isQuoteOf('create an index', 'I would add an index')).toBe(false);
    // Trivial fragments are not evidence, even when verbatim; a whole short answer is.
    expect(isQuoteOf('the', 'I would add the index')).toBe(false);
    expect(isQuoteOf('add the', 'I would add the index')).toBe(false);
    expect(isQuoteOf('Use a Set', 'Use a Set')).toBe(true);
  });

  it('drops resume-context items whose evidence is not verbatim', () => {
    const ctx = filterResumeContext(
      {
        skills: ['Node.js'],
        projects: [
          {
            name: 'Recon',
            summary: 's',
            technologies: [],
            contributions: [],
            evidence: 'payment reconciliation REST API',
          },
          {
            name: 'Invented',
            summary: 's',
            technologies: [],
            contributions: [],
            evidence: 'built a rocket',
          },
        ],
        experience: [],
        achievements: [{ text: 't', evidence: 'idempotent webhooks' }],
      },
      RESUME,
    );
    expect(ctx.projects.map((p) => p.name)).toEqual(['Recon']);
    expect(ctx.achievements).toHaveLength(1);
  });

  it('accepts null levels and rejects out-of-range levels', () => {
    const dims = Object.fromEntries(
      [
        'correctness',
        'relevance',
        'reasoning',
        'practical_understanding',
        'specificity',
        'consistency',
      ].map((d) => [d, { level: null, rationale: '', evidence: [] }]),
    );
    const base = {
      dimensions: dims,
      conceptsDemonstrated: [],
      conceptsMissing: [],
      incorrectStatements: [],
      strengths: [],
      gaps: [],
      uncertainty: { level: 'high', reasons: [] },
      transcriptionIssuesSuspected: false,
    };
    expect(answerEvaluationSchema.safeParse(base).success).toBe(true);
    expect(
      answerEvaluationSchema.safeParse({
        ...base,
        dimensions: { ...dims, correctness: { level: 5, rationale: '', evidence: [] } },
      }).success,
    ).toBe(false);
  });

  it('scores near-identical prompts as similar', () => {
    expect(
      promptSimilarity(
        'How does the event loop work in Node?',
        'How does the Node event loop work?',
      ),
    ).toBeGreaterThan(0.75);
    expect(
      promptSimilarity('How does the event loop work?', 'Design a rate limiter for an API.'),
    ).toBeLessThan(0.2);
  });
});

describe('question plan contract', () => {
  const slots = questionPlanSlots().slice(0, 3);
  const good = () => ({
    questions: [
      {
        slot: 0,
        type: 'background' as const,
        topic: 'Backend background',
        difficulty: 1,
        prompt: 'Could you walk me through the backend work you did on the reconciliation API?',
        targetSkills: [],
        resumeEvidence: null,
        expectedConcepts: ['scope of own work'],
      },
      {
        slot: 1,
        type: 'resume_project' as const,
        topic: 'Payment reconciliation API',
        difficulty: 2,
        prompt: 'You built a reconciliation REST API on MongoDB. How did you match ledger rows?',
        targetSkills: ['nodejs' as never],
        resumeEvidence: 'payment reconciliation REST API in Node.js',
        expectedConcepts: ['matching keys'],
      },
      {
        slot: 2,
        type: 'fundamentals' as const,
        topic: 'MongoDB indexes',
        difficulty: 3,
        prompt:
          'Which MongoDB index would you add for a reconciliation lookup, and what does it cost on writes?',
        targetSkills: [],
        resumeEvidence: null,
        expectedConcepts: ['compound index', 'write amplification'],
      },
    ],
  });

  it('accepts one grounded question per slot', () => {
    expect(checkQuestionPlan(good(), { slots }, RESUME)).toBeNull();
  });

  it('rejects wrong counts, slot order, difficulty, invented quotes, duplicates', () => {
    const count = good();
    count.questions.pop();
    expect(checkQuestionPlan(count, { slots }, RESUME)).toBe('wrong_question_count');
    const order = good();
    order.questions.reverse();
    expect(checkQuestionPlan(order, { slots }, RESUME)).toBe('slot_mismatch');
    const hard = good();
    hard.questions[0]!.difficulty = 5;
    expect(checkQuestionPlan(hard, { slots }, RESUME)).toBe('difficulty_out_of_range');
    const invented = good();
    invented.questions[1]!.resumeEvidence = 'Led a team of forty engineers at a large company';
    expect(checkQuestionPlan(invented, { slots }, RESUME)).toBe('resume_evidence_not_in_resume');
    const missing = good();
    missing.questions[1]!.resumeEvidence = null;
    expect(checkQuestionPlan(missing, { slots }, RESUME)).toBe('resume_evidence_not_in_resume');
    const dupTopic = good();
    dupTopic.questions[2]!.topic = 'payment reconciliation api';
    expect(checkQuestionPlan(dupTopic, { slots }, RESUME)).toBe('duplicate_topic');
    const repeat = good();
    repeat.questions[2]!.prompt = repeat.questions[1]!.prompt;
    expect(checkQuestionPlan(repeat, { slots }, RESUME)).toBe('repeated_question');
  });

  it('validates the output shape strictly', () => {
    expect(questionPlanOutputSchema.safeParse(good()).success).toBe(true);
    const extra = { ...good(), note: 'x' };
    expect(questionPlanOutputSchema.safeParse(extra).success).toBe(false);
  });
});
