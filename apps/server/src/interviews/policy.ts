import {
  INTERVIEW_LIMITS as L,
  type AnswerSignal,
  type QuestionType,
  type TurnIntent,
} from '@cofoundry/shared';
import type { QuestionPlanSlot, TurnHistoryItem, TurnPolicy } from '../ai/types.js';
import type { TurnRecord } from './records.js';

/**
 * Explicit interview state machine rules (Phase 8). Pure functions: the server computes the
 * policy for each turn, the model must follow it, and checkTurnPolicy (ai/contracts.ts)
 * verifies the result. This is what keeps questioning varied, bounded and non-repetitive.
 */

/** Order in which new topics are opened; after the plan, the last three types rotate. */
export const COVERAGE_PLAN: readonly QuestionType[] = [
  'background',
  'resume_project',
  'fundamentals',
  'resume_project',
  'architecture',
  'problem_solving',
  'scenario',
  'resume_project',
  'architecture',
  'fundamentals',
];

/** Types that must each be covered before the conversation may end early. */
export const REQUIRED_COVERAGE: readonly QuestionType[] = [
  'background',
  'resume_project',
  'fundamentals',
  'architecture',
];

export function questionTurns(turns: readonly TurnRecord[]): TurnRecord[] {
  return turns.filter((t) => t.kind === 'question');
}

/** Number of topics opened so far (questions that are not follow-ups). */
export function openedTopics(turns: readonly TurnRecord[]): number {
  return questionTurns(turns).filter((t) => t.parentIndex === null).length;
}

/**
 * Topics prepared before the interview: the first PLANNED_TOPICS entries of the coverage plan.
 * Slot i is the i-th opened topic, so a prepared question always has the type the policy expects.
 * Follow-ups stay adaptive and are generated live.
 */
export const PLANNED_TOPICS = 7;

export function questionPlanSlots(): QuestionPlanSlot[] {
  return COVERAGE_PLAN.slice(0, PLANNED_TOPICS).map((type, slot) => ({
    slot,
    type,
    difficultyMin: slot === 0 ? 1 : 2,
    difficultyMax: slot === 0 ? 2 : slot < 3 ? 3 : 4,
  }));
}

export function newTopicType(turns: readonly TurnRecord[]): QuestionType {
  const opened = openedTopics(turns);
  if (opened < COVERAGE_PLAN.length) return COVERAGE_PLAN[opened]!;
  const tail = COVERAGE_PLAN.slice(-3);
  return tail[(opened - COVERAGE_PLAN.length) % tail.length]!;
}

export function followUpDepth(turns: readonly TurnRecord[], index: number): number {
  let depth = 0;
  let current = turns.find((t) => t.index === index);
  while (current && current.parentIndex !== null && depth < 20) {
    depth += 1;
    const parent = current.parentIndex;
    current = turns.find((t) => t.index === parent);
  }
  return depth;
}

/** Follow-up intent the model must use for each reading of the last answer. */
export function intentForSignal(last: TurnRecord | null): Record<AnswerSignal, TurnIntent> {
  return {
    strong: last?.questionType === 'resume_project' ? 'implementation_detail' : 'go_deeper',
    partial: 'focused_follow_up',
    vague: 'request_example',
    incorrect: 'check_understanding',
    unclear_audio: 'clarify',
    no_answer: 'new_topic',
    not_applicable: 'new_topic',
  };
}

export interface ConversationClock {
  now: Date;
  conversationDeadline: Date;
}

export function remainingSeconds(clock: ConversationClock): number {
  return Math.max(
    0,
    Math.floor((clock.conversationDeadline.getTime() - clock.now.getTime()) / 1000),
  );
}

/** Server-side end of the conversation: question budget or time used up. No model call needed. */
export function conversationMustEnd(
  turns: readonly TurnRecord[],
  clock: ConversationClock,
): boolean {
  return questionTurns(turns).length >= L.maxQuestions || remainingSeconds(clock) < 60;
}

export function answeredCount(turns: readonly TurnRecord[]): number {
  return questionTurns(turns).filter((t) => t.answer && !t.answer.skipped).length;
}

export function coveredTypes(turns: readonly TurnRecord[]): QuestionType[] {
  const set = new Set<QuestionType>();
  for (const t of questionTurns(turns))
    if (t.questionType && t.answer && !t.answer.skipped) set.add(t.questionType);
  return [...set];
}

export function computeTurnPolicy(
  turns: readonly TurnRecord[],
  clock: ConversationClock,
): TurnPolicy {
  const questions = questionTurns(turns);
  const last = questions[questions.length - 1] ?? null;
  const depth = last ? followUpDepth(turns, last.index) : 0;
  const lastSkipped = last?.answer?.skipped ?? false;
  // One understanding check or clarification per topic, then move on (no repeated trapping).
  const exhaustedProbe = last?.intent === 'check_understanding' || last?.intent === 'clarify';
  const mustChangeTopic =
    last === null || lastSkipped || depth >= L.maxFollowUpDepth || exhaustedProbe;
  const d = last?.difficulty ?? 2;
  const covered = coveredTypes(turns);
  return {
    newTopicType: newTopicType(turns),
    mustChangeTopic,
    followUpDepth: depth,
    maxFollowUpDepth: L.maxFollowUpDepth,
    coveredTopics: [...new Set(questions.map((q) => q.topic).filter((t): t is string => !!t))],
    difficultyMin: last ? Math.max(1, d - 1) : 1,
    difficultyMax: last ? Math.min(5, d + 1) : 3,
    remainingQuestions: Math.max(0, L.maxQuestions - questions.length),
    remainingMinutes: Math.floor(remainingSeconds(clock) / 60),
    mayEnd:
      answeredCount(turns) >= L.minQuestions && REQUIRED_COVERAGE.every((t) => covered.includes(t)),
    intentForSignal: intentForSignal(last),
  };
}

const RECENT_ANSWERS = 4;
const ANSWER_CHARS_FOR_PROMPT = 1_500;

/** History sent to the interviewer: recent answers in full (bounded), older ones as topics only. */
export function historyForPrompt(
  turns: readonly TurnRecord[],
  redact: (text: string) => string,
): TurnHistoryItem[] {
  const questions = questionTurns(turns).filter((t) => t.answer);
  const recent = new Set(questions.slice(-RECENT_ANSWERS).map((t) => t.index));
  return questions.map((t) => ({
    index: t.index,
    questionType: t.questionType!,
    topic: t.topic ?? '',
    intent: t.intent!,
    difficulty: t.difficulty ?? 2,
    prompt: t.prompt,
    answer:
      recent.has(t.index) && t.answer && !t.answer.skipped
        ? Array.from(redact(t.answer.text)).slice(0, ANSWER_CHARS_FOR_PROMPT).join('')
        : null,
    answerStatus: t.answer!.skipped ? 'skipped' : 'answered',
    inputMode: t.answer!.skipped ? null : t.answer!.inputMode,
    transcriptConfidence: t.answer!.transcriptConfidence,
  }));
}
