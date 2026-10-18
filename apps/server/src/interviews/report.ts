import {
  CODE_REVIEW_DIMENSIONS,
  CODING_WEIGHTS,
  COMMUNICATION_DIMENSIONS,
  EVIDENCE_BANDS,
  EXPECTED_QUESTIONS,
  INTERVIEW_REPORT_NOTICE,
  MIN_TECHNICAL_COVERAGE,
  OVERALL_WEIGHTS,
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  RUBRIC_VERSION,
  TECHNICAL_DIMENSIONS,
  TECHNICAL_RUBRIC,
  answerScore,
  codingAggregate,
  communicationScore,
  formatScore,
  overallAggregate,
  technicalAggregate,
  type AnswerOutcome,
  type CodeReviewDimension,
  type CommunicationDimension,
  type DimensionJudgment,
  type InterviewReportView,
  type LevelMap,
  type QuestionEvaluationView,
  type TechnicalDimension,
} from '@cofoundry/shared';
import { findTask } from '../coding/tasks.js';
import { questionTurns } from './policy.js';
import type {
  AnswerEvaluationRecord,
  EvaluationSteps,
  InterviewRecord,
  JudgmentRecord,
} from './records.js';

/**
 * Deterministic report assembly (Phase 10). Every number comes from the rubric functions in
 * packages/shared/src/rubric.ts applied to stored, evidence-checked per-dimension levels. No model
 * writes the summary, scores or recommendations: they are templates over computed values, so
 * nothing in the report is invented.
 */

export type StoredReport = Omit<InterviewReportView, 'evaluationStatus' | 'retryAllowed'>;

function levels<D extends string>(
  dims: Record<string, JudgmentRecord> | null,
  keys: readonly D[],
): LevelMap<D> | null {
  if (!dims) return null;
  return Object.fromEntries(keys.map((k) => [k, dims[k]?.level ?? null])) as LevelMap<D>;
}

function judgments<D extends string>(
  dims: Record<string, JudgmentRecord> | null,
  keys: readonly D[],
): Record<D, DimensionJudgment> | null {
  if (!dims) return null;
  return Object.fromEntries(
    keys.map((k) => [
      k,
      {
        level: dims[k]?.level ?? null,
        rationale: dims[k]?.rationale ?? '',
        evidence: dims[k]?.evidence ?? [],
      },
    ]),
  ) as Record<D, DimensionJudgment>;
}

function outcomeOf(e: AnswerEvaluationRecord | undefined): AnswerOutcome {
  if (!e || e.status === 'not_assessed') return { kind: 'not_assessed' };
  if (e.status === 'skipped') return { kind: 'skipped' };
  return { kind: 'evaluated', levels: levels(e.dimensions, TECHNICAL_DIMENSIONS)! };
}

const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

export function buildReport(
  rec: InterviewRecord,
  steps: EvaluationSteps,
  ctx: {
    candidate: { displayName: string; demoAccount: boolean };
    reportVersion: number;
    now: Date;
  },
): StoredReport {
  const qs = questionTurns(rec.turns).filter((t) => t.answer);
  const questions: QuestionEvaluationView[] = qs.map((t) => {
    const e = steps.answers[String(t.index)];
    const outcome = outcomeOf(e);
    const score = answerScore(outcome);
    // Evaluated, but correctness had no quoted evidence: excluded, and labelled as such.
    const insufficient = outcome.kind === 'evaluated' && score === null;
    return {
      index: t.index,
      questionType: t.questionType,
      topic: t.topic,
      intent: t.intent,
      difficulty: t.difficulty,
      prompt: t.prompt,
      resumeEvidence: t.resumeEvidence,
      answer: t.answer
        ? {
            text: t.answer.text,
            inputMode: t.answer.inputMode,
            transcriptConfidence: t.answer.transcriptConfidence,
            uncertainSegments: t.answer.uncertainSegments,
            edited: t.answer.edited,
            editRatio: t.answer.editRatio,
            skipped: t.answer.skipped,
            skipReason: t.answer.skipReason,
          }
        : null,
      status: insufficient ? 'not_assessed' : outcome.kind,
      notAssessedReason:
        e?.notAssessedReason ??
        (insufficient
          ? 'Correctness could not be judged from quoted evidence, so this answer is excluded from the technical score.'
          : outcome.kind === 'not_assessed'
            ? 'Not evaluated.'
            : null),
      score,
      dimensions: judgments(e?.dimensions ?? null, TECHNICAL_DIMENSIONS),
      conceptsDemonstrated: e?.conceptsDemonstrated ?? [],
      conceptsMissing: e?.conceptsMissing ?? [],
      incorrectStatements: e?.incorrectStatements ?? [],
      strengths: e?.strengths ?? [],
      gaps: e?.gaps ?? [],
      uncertainty: e?.uncertainty ?? null,
      transcriptionIssuesSuspected: e?.transcriptionIssuesSuspected ?? false,
      provenance: e?.provenance ?? null,
    };
  });

  const technical = technicalAggregate(qs.map((t) => outcomeOf(steps.answers[String(t.index)])));
  const byType = QUESTION_TYPES.map((type) => {
    const of = questions.filter((q) => q.questionType === type);
    return {
      questionType: type,
      count: of.length,
      score: mean(of.map((q) => q.score).filter((s): s is number => s !== null)),
    };
  }).filter((x) => x.count > 0);
  const byDimension = TECHNICAL_DIMENSIONS.map((d) => ({
    dimension: d,
    meanLevel: mean(
      questions
        .filter((q) => q.status !== 'skipped')
        .map((q) => q.dimensions?.[d]?.level)
        .filter((l): l is number => typeof l === 'number'),
    ),
  }));

  // Coding
  const task = rec.coding ? findTask(rec.coding.taskId) : undefined;
  const grade = steps.codeGrade;
  const review = steps.codeReview;
  const functionalTests = grade?.tests.filter((t) => t.category !== 'performance') ?? [];
  const perfTests = grade?.tests.filter((t) => t.category === 'performance') ?? [];
  const executed = grade?.status === 'executed';
  const coding = codingAggregate({
    // Blank code counts as no submission (0), not as "not assessed".
    noSubmission:
      !!rec.coding && (!rec.coding.submission || rec.coding.submission.code.trim() === ''),
    compileError: grade?.compileError ?? false,
    functional: executed
      ? {
          passed: functionalTests.filter((t) => t.outcome === 'passed').length,
          total: functionalTests.length,
        }
      : null,
    efficiency:
      executed && perfTests.length > 0
        ? {
            passed: perfTests.filter((t) => t.outcome === 'passed').length,
            total: perfTests.length,
          }
        : null,
    review:
      review?.status === 'evaluated' ? levels(review.dimensions, CODE_REVIEW_DIMENSIONS) : null,
  });
  const codingView =
    rec.coding && task
      ? {
          task: {
            taskId: task.id,
            taskVersion: task.version,
            title: task.title,
            kind: task.kind,
            prompt: task.prompt,
            selectionReason: rec.coding.selection.reason,
          },
          submission: rec.coding.submission,
          execution: {
            status: grade?.status ?? 'not_run',
            message: grade?.message ?? null,
            compileError: grade?.compileError ?? false,
            diagnostics: grade?.diagnostics ?? null,
          },
          tests: grade?.tests ?? [],
          testsPassed: (grade?.tests ?? []).filter((t) => t.outcome === 'passed').length,
          testsTotal: (grade?.tests ?? []).length,
          functionalScore: coding.functional,
          efficiencyScore: coding.efficiency,
          review: {
            status: review?.status ?? 'not_assessed',
            notAssessedReason:
              review?.notAssessedReason ?? (review ? null : 'No code review was produced.'),
            dimensions: judgments(review?.dimensions ?? null, CODE_REVIEW_DIMENSIONS),
            explanationFeedback: review?.explanationFeedback ?? '',
            improvements: review?.improvements ?? [],
            issues: review?.issues ?? [],
            summary: review?.summary ?? '',
            provenance: review?.provenance ?? null,
          },
          qualityScore: coding.quality,
          score: coding.score,
        }
      : null;

  const overall = overallAggregate(technical, coding);
  const comm = steps.communication;
  const commLevels =
    comm?.status === 'evaluated' ? levels(comm.dimensions, COMMUNICATION_DIMENSIONS) : null;
  const communication = {
    status: comm?.status ?? ('not_assessed' as const),
    notAssessedReason:
      comm?.notAssessedReason ?? (comm ? null : 'Communication was not evaluated.'),
    score: commLevels ? communicationScore(commLevels as LevelMap<CommunicationDimension>) : null,
    dimensions: judgments(comm?.dimensions ?? null, COMMUNICATION_DIMENSIONS),
    overallFeedback: comm?.overallFeedback ?? '',
    strengths: comm?.strengths ?? [],
    suggestions: comm?.suggestions ?? [],
    provenance: comm?.provenance ?? null,
    notice:
      'Communication feedback is separate and never changes technical or coding scores. Accent, ' +
      'fluency and transcription errors are not penalised.',
  };

  const projectQs = questions.filter((q) => q.questionType === 'resume_project');
  const strengths = questions
    .flatMap((q) => q.strengths.map((s) => ({ ...s, questionIndex: q.index })))
    .slice(0, 10);
  const knowledgeGaps = questions
    .flatMap((q) => q.gaps.map((g) => ({ ...g, questionIndex: q.index })))
    .slice(0, 12);

  // Limitations and review recommendations (deterministic, from recorded facts).
  const limitations: string[] = [
    'AI evaluations can be wrong; quoted evidence shows what each judgment is based on.',
    'Personal-data removal before AI processing is best-effort, not a guarantee of anonymity.',
  ];
  const providers = new Set(
    [
      ...questions.map((q) => q.provenance?.provider),
      comm?.provenance?.provider,
      review?.provenance?.provider,
    ].filter(Boolean),
  );
  if (providers.has('mock')) {
    limitations.unshift(
      'TEST DATA: produced by the deterministic mock AI provider, not a real model.',
    );
  }
  const lowConf = questions.filter((q) => q.answer?.transcriptConfidence === 'low').length;
  if (lowConf > 0) limitations.push(`${lowConf} answer(s) had low speech-recognition confidence.`);
  const edited = questions.filter((q) => q.answer?.edited).length;
  if (edited > 0)
    limitations.push(
      `The candidate edited ${edited} transcript(s) before submitting (edit share shown per answer).`,
    );
  const typed = questions.filter(
    (q) => q.answer && !q.answer.skipped && q.answer.inputMode === 'typed',
  ).length;
  if (typed > 0) limitations.push(`${typed} answer(s) were typed rather than spoken.`);
  const notAssessed = questions.filter((q) => q.status === 'not_assessed').length;
  if (notAssessed > 0)
    limitations.push(
      `${notAssessed} answer(s) could not be assessed and are excluded from the technical score.`,
    );
  if (technical.coverage < MIN_TECHNICAL_COVERAGE) {
    limitations.push(
      `Only ${technical.assessed} assessed answer(s) out of at least ${EXPECTED_QUESTIONS} expected: evidence is insufficient for an overall level.`,
    );
  }
  if (codingView && codingView.execution.status === 'unavailable') {
    limitations.push(
      'Code execution was unavailable: tests did not run and no coding score was produced.',
    );
  } else if (codingView && codingView.execution.status === 'failed') {
    limitations.push(
      'The code execution sandbox failed: tests did not complete and no coding score was produced.',
    );
  }
  if (!rec.coding)
    limitations.push('The coding round did not take place (time ran out or it was not reached).');
  if (rec.coding?.selection.method === 'rule_based')
    limitations.push(
      'The coding task was chosen by rule because AI task selection was unavailable.',
    );
  const injectionFlags: InterviewReportView['injectionFlags'] = [];
  if (rec.resumeInjectionSuspected) injectionFlags.push({ source: 'resume', questionIndex: null });
  for (const t of qs)
    if (t.answer?.injectionSuspected)
      injectionFlags.push({ source: 'answer', questionIndex: t.index });
  if (
    rec.coding?.submission &&
    /ignore (all |previous |prior )?instructions|system prompt/i.test(
      rec.coding.submission.code + rec.coding.submission.explanation,
    )
  ) {
    injectionFlags.push({ source: 'code', questionIndex: null });
  }
  if (injectionFlags.length > 0) {
    limitations.push(
      'Text resembling instructions to the AI was found in candidate content; it was treated as data, but review those items manually.',
    );
  }

  const reviewRecommendations: string[] = [
    'Use this report as one input to a human decision; it never accepts or rejects a candidate on its own.',
  ];
  if (projectQs.length > 0)
    reviewRecommendations.push(
      'Verify the resume project claims discussed here in a follow-up conversation.',
    );
  if (knowledgeGaps.length > 0) {
    reviewRecommendations.push(
      `Discuss the listed knowledge gaps, starting with: ${knowledgeGaps[0]!.point}`,
    );
  }
  if (lowConf > 0 || edited > 0)
    reviewRecommendations.push(
      'Read the answers flagged for transcription confidence or edits in full before relying on them.',
    );
  if (questions.some((q) => q.uncertainty?.level === 'high')) {
    reviewRecommendations.push(
      'Some judgments were marked highly uncertain by the evaluator; review those answers yourself.',
    );
  }
  if (overall.evidenceLevel === 'insufficient')
    reviewRecommendations.push(
      'Consider a live conversation: there is not enough evidence for an overall level.',
    );

  const answered = questions.filter((q) => q.answer && !q.answer.skipped).length;
  const skipped = questions.filter((q) => q.answer?.skipped).length;
  const summary = [
    `${ctx.candidate.displayName} answered ${answered} of ${questions.length} question(s)${skipped ? ` (${skipped} skipped)` : ''}` +
      ` covering ${byType.map((b) => QUESTION_TYPE_LABELS[b.questionType].toLowerCase()).join(', ') || 'no topics'}.`,
    `Technical answers: ${formatScore(technical.score)} / 100 from ${technical.assessed} assessed answer(s).`,
    codingView
      ? codingView.score === null
        ? `Coding task "${codingView.task.title}": no coding score (${codingView.execution.status === 'unavailable' ? 'execution unavailable' : codingView.execution.status === 'failed' ? 'the sandbox failed' : 'tests did not run'}).`
        : `Coding task "${codingView.task.title}": ${codingView.testsPassed}/${codingView.testsTotal} tests passed, coding score ${formatScore(codingView.score)}.`
      : 'No coding task was completed.',
    `Overall technical assessment: ${formatScore(overall.score)} — ${overall.evidenceLevel} evidence (communication reported separately).`,
  ].join(' ');

  return {
    interviewId: rec.id,
    reportVersion: ctx.reportVersion,
    rubricVersion: RUBRIC_VERSION,
    generatedAt: ctx.now.toISOString(),
    candidate: ctx.candidate,
    briefTitle: rec.briefPreview.title,
    briefVersion: rec.briefVersion,
    summary,
    overall,
    technical: { ...technical, byType, byDimension },
    questions,
    resumeUnderstanding: {
      projectQuestions: projectQs.length,
      meanScore: mean(projectQs.map((q) => q.score).filter((s): s is number => s !== null)),
      notes: projectQs.flatMap((q) => q.conceptsDemonstrated.slice(0, 2)).slice(0, 6),
    },
    strengths,
    knowledgeGaps,
    communication,
    coding: codingView,
    methodology: {
      technicalWeights: Object.fromEntries(
        TECHNICAL_DIMENSIONS.map((d) => [d, TECHNICAL_RUBRIC[d].weight]),
      ) as Record<TechnicalDimension, number>,
      codingWeights: { ...CODING_WEIGHTS },
      overallWeights: { ...OVERALL_WEIGHTS },
      evidenceBands: { ...EVIDENCE_BANDS },
      minCoverage: MIN_TECHNICAL_COVERAGE,
      explanation: [
        `Rubric ${RUBRIC_VERSION}. Each answer is judged on six dimensions (0-4) by the evaluator model, which must quote the answer as evidence; a level without a valid quote is discarded as "insufficient evidence".`,
        'Answer score = weighted mean of the available dimension levels x 25. An answer whose correctness cannot be assessed is excluded; a skipped or timed-out question scores 0.',
        `Technical score = mean answer score. Coverage = assessed answers / max(asked, ${EXPECTED_QUESTIONS}); below ${MIN_TECHNICAL_COVERAGE * 100}% the evidence level is "insufficient".`,
        `Coding score = ${CODING_WEIGHTS.functional * 100}% deterministic functional tests (visible + hidden), ${CODING_WEIGHTS.efficiency * 100}% performance check, ${CODING_WEIGHTS.quality * 100}% AI code review; without executed tests there is no coding score.`,
        `Overall technical assessment = ${OVERALL_WEIGHTS.technical * 100}% technical + ${OVERALL_WEIGHTS.coding * 100}% coding (re-normalised when a part is missing). Bands: >= ${EVIDENCE_BANDS.strong} strong, >= ${EVIDENCE_BANDS.moderate} mixed, otherwise limited.`,
        'Communication is scored on its own scale and never enters the overall technical assessment.',
        'The weights are an initial documented configuration, not an empirically validated model; calibrate against human-reviewed interviews before relying on them.',
      ],
    },
    limitations,
    reviewRecommendations,
    injectionFlags,
    notice: INTERVIEW_REPORT_NOTICE,
  };
}

export type { CodeReviewDimension };
