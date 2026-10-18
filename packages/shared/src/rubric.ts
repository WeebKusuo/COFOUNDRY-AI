/**
 * Interview scoring rubric `rubric-interview-v1` (Phase 10).
 *
 * The rubric is configuration: every weight, scale and band below is documented in
 * docs/architecture/INTERVIEW_SCORING.md and pinned by the calibration fixtures at the end of
 * this file (tests assert the aggregation reproduces them exactly). Changing a number requires a
 * new rubric version and updated fixtures; stored reports keep the version they were computed
 * with.
 *
 * Principles:
 *  - Models return per-dimension levels 0-4 with quoted evidence; the backend computes every
 *    aggregate. A model can never set or override an aggregate score.
 *  - A dimension without supporting evidence is `null` ("insufficient evidence"), which is
 *    excluded — it is not treated as wrong. An answer whose correctness cannot be assessed is
 *    excluded from the technical score and reduces coverage instead.
 *  - Technical and coding dominate the overall technical assessment. Communication is reported
 *    separately and never enters any technical or coding number.
 *  - The initial weights are a documented starting point chosen for transparency (correctness
 *    first, then reasoning), not an empirically validated model; they must be calibrated against
 *    human-reviewed interviews before any decision relies on them.
 */

export const RUBRIC_VERSION = 'rubric-interview-v1' as const;
export const LEVEL_MAX = 4;

export const TECHNICAL_DIMENSIONS = [
  'correctness',
  'relevance',
  'reasoning',
  'practical_understanding',
  'specificity',
  'consistency',
] as const;
export type TechnicalDimension = (typeof TECHNICAL_DIMENSIONS)[number];

export const COMMUNICATION_DIMENSIONS = [
  'clarity',
  'structure',
  'technical_explanation',
  'reasoning_communication',
  'grammar',
] as const;
export type CommunicationDimension = (typeof COMMUNICATION_DIMENSIONS)[number];

export const CODE_REVIEW_DIMENSIONS = ['readability', 'approach', 'edge_case_handling'] as const;
export type CodeReviewDimension = (typeof CODE_REVIEW_DIMENSIONS)[number];

export interface DimensionDefinition {
  label: string;
  weight: number;
  /** What each level 0-4 means; shown to evaluators and in the report methodology. */
  levels: readonly [string, string, string, string, string];
}

export const TECHNICAL_RUBRIC: Readonly<Record<TechnicalDimension, DimensionDefinition>> = {
  correctness: {
    label: 'Correctness',
    weight: 0.3,
    levels: [
      'Central claims are wrong.',
      'Mostly wrong with some correct fragments.',
      'Partly correct with notable errors or gaps.',
      'Correct with minor imprecision.',
      'Correct and precise.',
    ],
  },
  relevance: {
    label: 'Relevance',
    weight: 0.1,
    levels: [
      'Does not address the question.',
      'Mostly off-topic.',
      'Addresses part of the question.',
      'Addresses the question.',
      'Addresses the question directly and completely.',
    ],
  },
  reasoning: {
    label: 'Reasoning quality',
    weight: 0.2,
    levels: [
      'No reasoning given.',
      'Assertions without justification.',
      'Some justification; trade-offs missing.',
      'Sound reasoning with trade-offs.',
      'Rigorous reasoning, alternatives and trade-offs weighed.',
    ],
  },
  practical_understanding: {
    label: 'Practical understanding',
    weight: 0.15,
    levels: [
      'No practical grounding.',
      'Textbook only.',
      'Some practical awareness.',
      'Clear practical experience or application.',
      'Deep practical insight (failure modes, operations, testing).',
    ],
  },
  specificity: {
    label: 'Specificity & depth',
    weight: 0.15,
    levels: [
      'Entirely generic.',
      'Mostly generic.',
      'Some concrete detail.',
      'Concrete details and examples.',
      'Detailed, implementation-level specifics.',
    ],
  },
  consistency: {
    label: 'Consistency',
    weight: 0.1,
    levels: [
      'Contradicts earlier answers or the resume claim.',
      'Major inconsistencies.',
      'Minor inconsistencies.',
      'Consistent.',
      'Consistent and builds on earlier answers.',
    ],
  },
};

export const COMMUNICATION_RUBRIC: Readonly<Record<CommunicationDimension, DimensionDefinition>> = {
  clarity: {
    label: 'Clarity',
    weight: 0.25,
    levels: [
      'Hard to follow.',
      'Often unclear.',
      'Understandable with effort.',
      'Clear.',
      'Very clear and concise.',
    ],
  },
  structure: {
    label: 'Sentence & answer structure',
    weight: 0.2,
    levels: [
      'No discernible structure.',
      'Disorganised.',
      'Some structure.',
      'Well organised.',
      'Logically sequenced throughout.',
    ],
  },
  technical_explanation: {
    label: 'Technical explanation',
    weight: 0.25,
    levels: [
      'Cannot explain technical points.',
      'Explanations are confusing.',
      'Explains with gaps.',
      'Explains technical points well.',
      'Explains complex points simply and accurately.',
    ],
  },
  reasoning_communication: {
    label: 'Communicating reasoning',
    weight: 0.2,
    levels: [
      'Reasoning is not expressed.',
      'Reasoning is hard to follow.',
      'Reasoning partly expressed.',
      'Reasoning expressed clearly.',
      'Reasoning expressed step by step with justification.',
    ],
  },
  grammar: {
    label: 'Grammar (lenient)',
    weight: 0.1,
    levels: [
      'Errors prevent understanding.',
      'Frequent errors that impede understanding.',
      'Errors that rarely impede understanding.',
      'Few errors.',
      'Essentially error-free.',
    ],
  },
};

export const CODE_REVIEW_RUBRIC: Readonly<Record<CodeReviewDimension, DimensionDefinition>> = {
  readability: {
    label: 'Readability',
    weight: 1 / 3,
    levels: [
      'Unreadable.',
      'Hard to read.',
      'Readable with effort.',
      'Readable and well named.',
      'Exemplary readability.',
    ],
  },
  approach: {
    label: 'Approach',
    weight: 1 / 3,
    levels: [
      'No workable approach.',
      'Flawed approach.',
      'Workable but weak.',
      'Sound approach.',
      'Excellent, idiomatic approach.',
    ],
  },
  edge_case_handling: {
    label: 'Edge-case handling',
    weight: 1 / 3,
    levels: [
      'Ignores edge cases.',
      'Handles few edge cases.',
      'Handles some edge cases.',
      'Handles the important edge cases.',
      'Handles edge cases thoroughly.',
    ],
  },
};

/** Coding score parts. Functional tests are required: the review alone never produces a score. */
export const CODING_WEIGHTS = { functional: 0.6, efficiency: 0.15, quality: 0.25 } as const;
/** Overall technical assessment. Communication is deliberately absent. */
export const OVERALL_WEIGHTS = { technical: 0.6, coding: 0.4 } as const;
/** Coverage below this makes the evidence level "insufficient". */
export const MIN_TECHNICAL_COVERAGE = 0.6;
/**
 * Coverage = assessed answers / max(asked questions, EXPECTED_QUESTIONS), so ending the
 * conversation after one or two answers can never produce a confident result.
 */
export const EXPECTED_QUESTIONS = 6;

export const EVIDENCE_LEVELS = ['strong', 'moderate', 'limited', 'insufficient'] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];
export const EVIDENCE_LEVEL_LABELS: Readonly<Record<EvidenceLevel, string>> = {
  strong: 'Strong evidence of competency',
  moderate: 'Mixed evidence',
  limited: 'Limited evidence',
  insufficient: 'Insufficient evidence to assess',
};
export const EVIDENCE_BANDS = { strong: 75, moderate: 50 } as const;

// --- Aggregation (pure; used by the server and asserted against the fixtures) ------------------

export type LevelMap<D extends string> = Record<D, number | null>;

function assertLevel(v: number | null): void {
  if (v === null) return;
  if (!Number.isInteger(v) || v < 0 || v > LEVEL_MAX) {
    throw new RangeError(`Rubric level must be an integer 0-${LEVEL_MAX}, got ${v}`);
  }
}

/** Weights as exact integers (micro-units), so sums like 0.3 + 0.1 + ... never drift in floating point. */
const units = (w: number) => Math.round(w * 1_000_000);

/** Weighted mean of non-null levels, scaled to 0-100; null when no level is present. */
export function weightedLevelScore<D extends string>(
  levels: LevelMap<D>,
  rubric: Readonly<Record<D, DimensionDefinition>>,
): number | null {
  let num = 0;
  let den = 0;
  for (const key of Object.keys(rubric) as D[]) {
    const v = levels[key];
    assertLevel(v);
    if (v === null) continue;
    num += units(rubric[key].weight) * v;
    den += units(rubric[key].weight);
  }
  return den === 0 ? null : (100 * num) / (den * LEVEL_MAX);
}

export type AnswerOutcome =
  | { kind: 'evaluated'; levels: LevelMap<TechnicalDimension> }
  /** The candidate skipped or ran out of time: counts as 0. */
  | { kind: 'skipped' }
  /** Evaluation failed or the answer could not be assessed (e.g. unclear audio): excluded. */
  | { kind: 'not_assessed' };

/** Per-answer technical score, or null when the answer is excluded (correctness unassessable). */
export function answerScore(outcome: AnswerOutcome): number | null {
  if (outcome.kind === 'skipped') return 0;
  if (outcome.kind === 'not_assessed') return null;
  if (outcome.levels.correctness === null) return null;
  return weightedLevelScore(outcome.levels, TECHNICAL_RUBRIC);
}

export interface TechnicalAggregate {
  score: number | null;
  asked: number;
  assessed: number;
  coverage: number;
}

export function technicalAggregate(outcomes: readonly AnswerOutcome[]): TechnicalAggregate {
  const scores = outcomes.map(answerScore).filter((s): s is number => s !== null);
  const asked = outcomes.length;
  return {
    score: scores.length === 0 ? null : scores.reduce((a, b) => a + b, 0) / scores.length,
    asked,
    assessed: scores.length,
    coverage: scores.length / Math.max(asked, EXPECTED_QUESTIONS),
  };
}

export interface CodingAggregateInput {
  /** Null when tests could not be executed (sandbox unavailable). */
  functional: { passed: number; total: number } | null;
  efficiency: { passed: number; total: number } | null;
  /** True when the submission failed to compile/parse: functional and efficiency count 0. */
  compileError: boolean;
  review: LevelMap<CodeReviewDimension> | null;
  /** No code was submitted at all. */
  noSubmission: boolean;
}

export interface CodingAggregate {
  score: number | null;
  functional: number | null;
  efficiency: number | null;
  quality: number | null;
}

export function codingAggregate(input: CodingAggregateInput): CodingAggregate {
  if (input.noSubmission) return { score: 0, functional: 0, efficiency: 0, quality: null };
  const ratio = (r: { passed: number; total: number } | null) =>
    r === null || r.total === 0 ? null : (100 * r.passed) / r.total;
  const functional =
    input.functional === null ? null : input.compileError ? 0 : ratio(input.functional);
  const efficiency =
    input.efficiency === null || input.functional === null
      ? null
      : input.compileError
        ? 0
        : ratio(input.efficiency);
  const quality = input.review ? weightedLevelScore(input.review, CODE_REVIEW_RUBRIC) : null;
  if (functional === null) return { score: null, functional, efficiency, quality };
  const parts: Array<[number, number]> = [[units(CODING_WEIGHTS.functional), functional]];
  if (efficiency !== null) parts.push([units(CODING_WEIGHTS.efficiency), efficiency]);
  if (quality !== null) parts.push([units(CODING_WEIGHTS.quality), quality]);
  const den = parts.reduce((a, [w]) => a + w, 0);
  return {
    score: parts.reduce((a, [w, v]) => a + w * v, 0) / den,
    functional,
    efficiency,
    quality,
  };
}

export interface OverallAggregate {
  score: number | null;
  evidenceLevel: EvidenceLevel;
  /** Which parts contributed. */
  basis: Array<'technical' | 'coding'>;
}

export function overallAggregate(
  technical: TechnicalAggregate,
  coding: CodingAggregate,
): OverallAggregate {
  const parts: Array<[number, number, 'technical' | 'coding']> = [];
  if (technical.score !== null)
    parts.push([units(OVERALL_WEIGHTS.technical), technical.score, 'technical']);
  if (coding.score !== null) parts.push([units(OVERALL_WEIGHTS.coding), coding.score, 'coding']);
  if (parts.length === 0 || technical.coverage < MIN_TECHNICAL_COVERAGE) {
    const den = parts.reduce((a, [w]) => a + w, 0);
    return {
      score: den === 0 ? null : parts.reduce((a, [w, v]) => a + w * v, 0) / den,
      evidenceLevel: 'insufficient',
      basis: parts.map(([, , k]) => k),
    };
  }
  const den = parts.reduce((a, [w]) => a + w, 0);
  const score = parts.reduce((a, [w, v]) => a + w * v, 0) / den;
  return {
    score,
    evidenceLevel:
      score >= EVIDENCE_BANDS.strong
        ? 'strong'
        : score >= EVIDENCE_BANDS.moderate
          ? 'moderate'
          : 'limited',
    basis: parts.map(([, , k]) => k),
  };
}

export function communicationScore(levels: LevelMap<CommunicationDimension>): number | null {
  return weightedLevelScore(levels, COMMUNICATION_RUBRIC);
}

/** Display rounding only; stored scores keep full precision. */
export function formatScore(score: number | null): string {
  return score === null ? '—' : (Math.round(score * 100) / 100).toFixed(2);
}

// --- Calibration fixtures (asserted by tests before aggregation is trusted) ---------------------

const lv = (
  correctness: number | null,
  relevance: number | null,
  reasoning: number | null,
  practical_understanding: number | null,
  specificity: number | null,
  consistency: number | null,
): LevelMap<TechnicalDimension> => ({
  correctness,
  relevance,
  reasoning,
  practical_understanding,
  specificity,
  consistency,
});

export const RUBRIC_CALIBRATION_FIXTURES = {
  answers: [
    { name: 'all 4', outcome: { kind: 'evaluated', levels: lv(4, 4, 4, 4, 4, 4) }, score: 100 },
    { name: 'all 2', outcome: { kind: 'evaluated', levels: lv(2, 2, 2, 2, 2, 2) }, score: 50 },
    {
      // 25*(0.3*3 + 0.1*4 + 0.2*2 + 0.15*3 + 0.15*1 + 0.1*4) = 25*2.7 = 67.5
      name: 'mixed',
      outcome: { kind: 'evaluated', levels: lv(3, 4, 2, 3, 1, 4) },
      score: 67.5,
    },
    {
      // Missing evidence is excluded, not zero: 25*(0.3*4+0.2*4)/(0.5) = 100
      name: 'missing evidence excluded',
      outcome: { kind: 'evaluated', levels: lv(4, null, 4, null, null, null) },
      score: 100,
    },
    {
      name: 'correctness unassessable',
      outcome: { kind: 'evaluated', levels: lv(null, 4, 4, 4, 4, 4) },
      score: null,
    },
    { name: 'skipped', outcome: { kind: 'skipped' }, score: 0 },
    { name: 'not assessed', outcome: { kind: 'not_assessed' }, score: null },
  ],
  coding: [
    {
      // 0.6*80 + 0.15*100 + 0.25*75 = 48 + 15 + 18.75 = 81.75
      name: 'full',
      input: {
        functional: { passed: 8, total: 10 },
        efficiency: { passed: 1, total: 1 },
        compileError: false,
        review: { readability: 3, approach: 3, edge_case_handling: 3 },
        noSubmission: false,
      },
      score: 81.75,
    },
    {
      name: 'execution unavailable: review alone never scores',
      input: {
        functional: null,
        efficiency: null,
        compileError: false,
        review: { readability: 4, approach: 4, edge_case_handling: 4 },
        noSubmission: false,
      },
      score: null,
    },
    {
      // Compile error: 0.6*0 + 0.15*0 + 0.25*50 = 12.5
      name: 'compile error',
      input: {
        functional: { passed: 0, total: 10 },
        efficiency: { passed: 0, total: 1 },
        compileError: true,
        review: { readability: 2, approach: 2, edge_case_handling: 2 },
        noSubmission: false,
      },
      score: 12.5,
    },
  ],
  overall: [
    // 0.6*70 + 0.4*90 = 78 -> strong
    { name: 'both parts', technical: 70, coverage: 1, coding: 90, score: 78, level: 'strong' },
    // coding unavailable -> technical only, still banded
    {
      name: 'technical only',
      technical: 60,
      coverage: 0.8,
      coding: null,
      score: 60,
      level: 'moderate',
    },
    // low coverage -> insufficient regardless of score
    {
      name: 'low coverage',
      technical: 90,
      coverage: 0.5,
      coding: 90,
      score: 90,
      level: 'insufficient',
    },
  ],
} as const;
