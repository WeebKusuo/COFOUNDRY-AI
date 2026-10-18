import { useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import {
  CODE_LANGUAGE_LABELS,
  CODE_REVIEW_RUBRIC,
  CODING_TASK_KIND_LABELS,
  COMMUNICATION_RUBRIC,
  EVIDENCE_LEVEL_LABELS,
  QUESTION_TYPE_LABELS,
  TECHNICAL_RUBRIC,
  TURN_INTENT_LABELS,
  formatScore,
  type DimensionDefinition,
  type DimensionJudgment,
  type InterviewReportView,
  type QuestionEvaluationView,
} from '@cofoundry/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  LoadingState,
  ErrorState,
} from '../../components/ui';
import { useReport, useRetryEvaluation } from './api';

function ScoreTile({ label, score, note }: { label: string; score: number | null; note?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface-sunk p-4">
      <p className="text-sm text-ink-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-ink">{formatScore(score)}</p>
      {note ? <p className="mt-1 text-xs text-ink-muted">{note}</p> : null}
    </div>
  );
}

function Dimensions({
  dims,
  rubric,
}: {
  dims: Record<string, DimensionJudgment> | null;
  rubric: Readonly<Record<string, DimensionDefinition>>;
}) {
  if (!dims) return null;
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="text-ink-muted">
          <th scope="col" className="py-1 pr-3 font-medium">
            Dimension
          </th>
          <th scope="col" className="py-1 pr-3 font-medium">
            Level (0–4)
          </th>
          <th scope="col" className="py-1 font-medium">
            Evidence and rationale
          </th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(rubric).map(([key, def]) => {
          const j = dims[key];
          return (
            <tr key={key} className="border-t border-line align-top">
              <th scope="row" className="py-2 pr-3 font-medium text-ink">
                {def.label}
              </th>
              <td className="py-2 pr-3 tabular-nums">
                {j?.level === null || j === undefined ? (
                  <span className="text-ink-muted">Insufficient evidence</span>
                ) : (
                  j.level
                )}
              </td>
              <td className="py-2 text-ink-muted">
                {j?.evidence.map((e) => (
                  <q key={e} className="block text-ink">
                    {e}
                  </q>
                ))}
                {j?.rationale ? <span className="block">{j.rationale}</span> : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function QuestionCard({ q, n }: { q: QuestionEvaluationView; n: number }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <Card as="article" aria-label={`Question ${n}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap gap-2">
              {q.questionType ? (
                <Badge tone="info">{QUESTION_TYPE_LABELS[q.questionType]}</Badge>
              ) : null}
              {q.intent && q.intent !== 'new_topic' ? (
                <Badge>{TURN_INTENT_LABELS[q.intent]}</Badge>
              ) : null}
              {q.difficulty ? <Badge>Difficulty {q.difficulty}/5</Badge> : null}
              {q.answer?.inputMode === 'voice' ? <Badge>Spoken</Badge> : null}
              {q.answer?.transcriptConfidence === 'low' ? (
                <Badge tone="caution">Low transcript confidence</Badge>
              ) : null}
              {q.answer?.edited ? (
                <Badge tone="caution">
                  Transcript edited ({Math.round((q.answer.editRatio ?? 0) * 100)}% of words)
                </Badge>
              ) : null}
              {q.uncertainty?.level === 'high' ? (
                <Badge tone="caution">High evaluator uncertainty</Badge>
              ) : null}
            </div>
            <h3 className="mt-2 font-semibold text-ink">
              {n}. {q.prompt}
            </h3>
            {q.resumeEvidence ? (
              <p className="mt-1 text-sm text-ink-muted">
                Based on the resume: <q>{q.resumeEvidence}</q>
              </p>
            ) : null}
          </div>
          <p
            className="text-xl font-bold tabular-nums text-ink"
            aria-label={`Score ${formatScore(q.score)}`}
          >
            {q.status === 'skipped' ? 'Skipped · 0' : formatScore(q.score)}
          </p>
        </div>
        {q.answer && !q.answer.skipped ? (
          <blockquote className="mt-3 whitespace-pre-line border-l-2 border-line-strong pl-3 text-sm text-ink">
            {q.answer.text}
          </blockquote>
        ) : null}
        {q.status === 'not_assessed' ? (
          <p className="mt-2 text-sm text-caution">Not assessed: {q.notAssessedReason}</p>
        ) : null}
        {q.status === 'evaluated' ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? 'Hide evaluation' : 'Show evaluation'}
            </Button>
            {open ? (
              <div className="mt-3 flex flex-col gap-3">
                <Dimensions dims={q.dimensions} rubric={TECHNICAL_RUBRIC} />
                {q.incorrectStatements.length ? (
                  <div>
                    <p className="text-sm font-medium text-ink">Incorrect statements</p>
                    <ul className="list-disc pl-5 text-sm text-ink-muted">
                      {q.incorrectStatements.map((s) => (
                        <li key={s.quote}>
                          <q>{s.quote}</q> — {s.issue}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {q.uncertainty?.reasons.length ? (
                  <p className="text-sm text-ink-muted">
                    Uncertainty: {q.uncertainty.reasons.join(' ')}
                  </p>
                ) : null}
                {q.provenance ? (
                  <p className="text-xs text-ink-faint">
                    {q.provenance.provider} · {q.provenance.model} · {q.provenance.promptVersion}
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </Card>
    </li>
  );
}

export function ReportView({ report: r }: { report: InterviewReportView }) {
  return (
    <div className="flex flex-col gap-6">
      <Alert tone="info" title="Supports human review — not a hiring decision">
        {r.notice}
      </Alert>
      {r.quarantine ? (
        <Alert tone="caution" title="Under moderator review">
          {r.quarantine.notice}
        </Alert>
      ) : null}
      {r.openCorrections ? (
        <Alert tone="caution" title="Correction requested">
          The candidate has an open correction request about this report. It has not been reviewed
          yet and does not change any score; consider it before deciding.
        </Alert>
      ) : null}
      {r.corrections && r.corrections.length > 0 ? (
        <Card as="section" aria-labelledby="corrections-heading">
          <CardHeader
            title={<span id="corrections-heading">Moderator corrections</span>}
            description="Attributed display corrections. The original answers and scores are unchanged."
          />
          <ul className="flex flex-col gap-2 text-sm">
            {r.corrections.map((c) => (
              <li key={c.caseId} className="rounded-lg bg-surface-sunk p-3 text-ink">
                <p>{c.text}</p>
                <p className="mt-1 text-xs text-ink-muted">
                  {c.by} · {new Date(c.at).toLocaleDateString()}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card as="section" aria-labelledby="summary-heading">
        <CardHeader
          title={<span id="summary-heading">Summary</span>}
          description={`Rubric ${r.rubricVersion} · report version ${r.reportVersion}`}
        />
        <p className="text-ink">{r.summary}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <ScoreTile
            label="Overall technical assessment"
            score={r.overall.score}
            note={EVIDENCE_LEVEL_LABELS[r.overall.evidenceLevel]}
          />
          <ScoreTile
            label="Technical answers"
            score={r.technical.score}
            note={`${r.technical.assessed} of ${r.technical.asked} questions · coverage ${Math.round(r.technical.coverage * 100)}%`}
          />
          <ScoreTile
            label="Coding"
            score={r.coding?.score ?? null}
            note={
              r.coding
                ? `${r.coding.testsPassed}/${r.coding.testsTotal} tests passed`
                : 'Not completed'
            }
          />
          <ScoreTile
            label="Communication (separate)"
            score={r.communication.score}
            note="Never part of the technical assessment"
          />
        </div>
      </Card>

      <Card as="section" aria-labelledby="competency-heading">
        <CardHeader title={<span id="competency-heading">Technical competency breakdown</span>} />
        <div className="grid gap-6 md:grid-cols-2">
          <table className="text-sm">
            <caption className="mb-2 text-left font-medium text-ink">By question type</caption>
            <tbody>
              {r.technical.byType.map((t) => (
                <tr key={t.questionType} className="border-t border-line">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal text-ink">
                    {QUESTION_TYPE_LABELS[t.questionType]} ({t.count})
                  </th>
                  <td className="py-1.5 text-right tabular-nums">{formatScore(t.score)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="text-sm">
            <caption className="mb-2 text-left font-medium text-ink">
              Mean level by dimension (0–4)
            </caption>
            <tbody>
              {r.technical.byDimension.map((d) => (
                <tr key={d.dimension} className="border-t border-line">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal text-ink">
                    {TECHNICAL_RUBRIC[d.dimension].label}
                  </th>
                  <td className="py-1.5 text-right tabular-nums">
                    {d.meanLevel === null ? '—' : d.meanLevel.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-sm text-ink-muted">
          Resume and project understanding: {r.resumeUnderstanding.projectQuestions} project
          question(s), mean {formatScore(r.resumeUnderstanding.meanScore)}.
        </p>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card as="section" aria-labelledby="strengths-heading">
          <CardHeader title={<span id="strengths-heading">Evidence-backed strengths</span>} />
          {r.strengths.length === 0 ? (
            <p className="text-sm text-ink-muted">No strengths with quoted evidence.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {r.strengths.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <CheckCircle2
                    className="mt-0.5 size-4 shrink-0 text-success"
                    aria-hidden="true"
                  />
                  <span>
                    {s.point} — <q>{s.evidence}</q>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card as="section" aria-labelledby="gaps-heading">
          <CardHeader title={<span id="gaps-heading">Knowledge gaps</span>} />
          {r.knowledgeGaps.length === 0 ? (
            <p className="text-sm text-ink-muted">None recorded.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {r.knowledgeGaps.map((g, i) => (
                <li key={i} className="flex gap-2">
                  {g.kind === 'incorrect' ? (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                  ) : (
                    <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
                  )}
                  <span>
                    {g.point}{' '}
                    <span className="text-ink-muted">
                      (
                      {g.kind === 'incorrect'
                        ? 'incorrect'
                        : 'no evidence given — not the same as wrong'}
                      )
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <section aria-labelledby="questions-heading" className="flex flex-col gap-3">
        <h2 id="questions-heading" className="text-lg font-semibold text-ink">
          Question-by-question evaluation
        </h2>
        <ol className="flex flex-col gap-3">
          {r.questions.map((q, i) => (
            <QuestionCard key={q.index} q={q} n={i + 1} />
          ))}
        </ol>
      </section>

      <Card as="section" aria-labelledby="comm-heading">
        <CardHeader
          title={<span id="comm-heading">English communication feedback</span>}
          description={r.communication.notice}
        />
        {r.communication.status === 'evaluated' ? (
          <div className="flex flex-col gap-3">
            <p className="text-ink">{r.communication.overallFeedback}</p>
            <Dimensions dims={r.communication.dimensions} rubric={COMMUNICATION_RUBRIC} />
            {r.communication.suggestions.length ? (
              <ul className="list-disc pl-5 text-sm text-ink-muted">
                {r.communication.suggestions.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-ink-muted">{r.communication.notAssessedReason}</p>
        )}
      </Card>

      {r.coding ? (
        <Card as="section" aria-labelledby="coding-heading">
          <CardHeader
            title={<span id="coding-heading">Coding task: {r.coding.task.title}</span>}
            description={`${CODING_TASK_KIND_LABELS[r.coding.task.kind]} · ${r.coding.task.selectionReason}`}
          />
          <p className="text-sm text-ink">{r.coding.task.prompt}</p>
          {r.coding.execution.status !== 'executed' ? (
            <Alert tone="caution" title="Tests did not run" className="mt-3">
              {r.coding.execution.message ?? 'No solution was executed.'}
            </Alert>
          ) : null}
          {r.coding.tests.length ? (
            <ul className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
              {r.coding.tests.map((t) => (
                <li key={`${t.category}-${t.name}`} className="flex items-center gap-2">
                  {t.outcome === 'passed' ? (
                    <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
                  ) : (
                    <AlertTriangle className="size-4 text-danger" aria-hidden="true" />
                  )}
                  <span>
                    {t.name}{' '}
                    <span className="text-ink-muted">
                      ({t.category}, {t.outcome})
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <ScoreTile label="Functional tests" score={r.coding.functionalScore} />
            <ScoreTile label="Performance check" score={r.coding.efficiencyScore} />
            <ScoreTile label="Code review (AI)" score={r.coding.qualityScore} />
          </div>
          {r.coding.submission ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium text-ink">
                Submitted solution ({CODE_LANGUAGE_LABELS[r.coding.submission.language]}
                {r.coding.submission.autoSubmitted ? ', auto-submitted at the deadline' : ''})
              </summary>
              <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-surface-sunk p-3 text-xs">
                <code>{r.coding.submission.code}</code>
              </pre>
              {r.coding.submission.explanation ? (
                <p className="mt-2 text-sm text-ink">
                  Explanation: {r.coding.submission.explanation}
                </p>
              ) : null}
            </details>
          ) : null}
          {r.coding.review.status === 'evaluated' ? (
            <div className="mt-4 flex flex-col gap-3">
              <p className="text-ink">{r.coding.review.summary}</p>
              <Dimensions dims={r.coding.review.dimensions} rubric={CODE_REVIEW_RUBRIC} />
              {r.coding.review.improvements.length ? (
                <ul className="list-disc pl-5 text-sm text-ink-muted">
                  {r.coding.review.improvements.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card as="section" aria-labelledby="method-heading">
        <CardHeader title={<span id="method-heading">Scoring methodology</span>} />
        <ul className="list-disc pl-5 text-sm text-ink-muted">
          {r.methodology.explanation.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </Card>

      <Card as="section" aria-labelledby="limits-heading">
        <CardHeader
          title={
            <span id="limits-heading">Limitations, uncertainty and review recommendations</span>
          }
        />
        <ul className="list-disc pl-5 text-sm text-ink">
          {r.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        <h3 className="mt-4 font-medium text-ink">Recommended review</h3>
        <ul className="list-disc pl-5 text-sm text-ink">
          {r.reviewRecommendations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/** Loads the report; shows pending/failed states with retry when allowed. */
export function ReportSection({
  interviewId,
  actions,
}: {
  interviewId: string;
  /** Extra controls shown under a ready report (collaboration request, correction). */
  actions?: (report: InterviewReportView) => ReactNode;
}) {
  const query = useReport(interviewId, true);
  const retry = useRetryEvaluation(interviewId);
  if (query.isPending) return <LoadingState label="Loading the report" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const data = query.data;
  if (data.state === 'pending') {
    return (
      <Alert
        tone={data.pending.evaluationStatus === 'failed' ? 'danger' : 'info'}
        title={
          data.pending.evaluationStatus === 'failed'
            ? 'Evaluation failed'
            : 'Evaluation in progress'
        }
        action={
          data.pending.retryAllowed ? (
            <Button variant="secondary" loading={retry.isPending} onClick={() => retry.mutate()}>
              Retry evaluation
            </Button>
          ) : null
        }
      >
        {data.pending.message}
      </Alert>
    );
  }
  return (
    <>
      {actions ? actions(data.report) : null}
      <ReportView report={data.report} />
    </>
  );
}
