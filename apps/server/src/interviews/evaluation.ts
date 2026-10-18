import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import {
  CODE_REVIEW_RUBRIC,
  COMMUNICATION_RUBRIC,
  INTERVIEW_CONTRACT_VERSION,
  ROLE_KEY,
  RUBRIC_VERSION,
  TECHNICAL_RUBRIC,
  redactForAi,
  type DimensionDefinition,
} from '@cofoundry/shared';
import {
  answerEvaluationSchema,
  codeReviewSchema,
  communicationEvaluationSchema,
  enforceEvidence,
  invokeCapability,
  worstCaseCallMs,
  type AiLogger,
  type AiProviderRegistry,
  type ConsentProof,
  type ProviderErrorCode,
} from '../ai/index.js';
import type { IdentityStore } from '../auth/store.js';
import { gradeSubmission } from '../coding/grading.js';
import { JudgeUnavailableError, type CodeJudge } from '../coding/judge.js';
import { findTask } from '../coding/tasks.js';
import { questionTurns } from './policy.js';
import type {
  AnswerEvaluationRecord,
  EvaluationJobRecord,
  EvaluationSteps,
  InterviewRecord,
  StepProvenance,
  TurnRecord,
} from './records.js';
import { buildReport } from './report.js';
import type { InterviewService } from './service.js';
import type { EvaluationJobStore, InterviewStore, ReportStore } from './store.js';
import { consentActive, partyOf } from './view.js';

/**
 * Durable evaluation worker (Phases 9-10). One job per submitted session; jobs are claimed with
 * a lease, every finished step is saved before the next starts (so a retry or a crash never
 * repeats completed provider calls), consent is re-checked before each dispatch and before the
 * report is committed, and failures back off exponentially up to the job's attempt budget.
 * There is no fallback that invents results: a step that cannot run leaves the job failed (or
 * the item explicitly "not assessed"), and the report says so.
 */

export interface EvaluationWorkerDeps {
  jobs: EvaluationJobStore;
  store: InterviewStore;
  reports: ReportStore;
  interviews: InterviewService;
  identity: IdentityStore;
  ai: AiProviderRegistry;
  aiCall: { timeoutMs: number; maxAttempts: number };
  judge: CodeJudge;
  logger: AiLogger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Base delay of the job-level backoff (10 s by default; tests use 0). */
  jobBackoffMs?: number;
}

/** Minimum evaluation lease; the effective lease also covers the slowest single step. */
const MIN_LEASE_MS = 5 * 60_000;
const ANSWER_CHARS = 4_000;
const CONTEXT_CHARS = 800;

class StepFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const rubricInput = (r: Readonly<Record<string, DimensionDefinition>>) =>
  Object.fromEntries(
    Object.entries(r).map(([k, v]) => [k, { label: v.label, levels: [...v.levels] }]),
  );

const cut = (s: string, n: number) => Array.from(s).slice(0, n).join('');

export class EvaluationWorker {
  private readonly now: () => Date;
  private readonly owner = `worker-${randomUUID()}`;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: EvaluationWorkerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  start(intervalMs = 2_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (await this.runOnce()) {
        /* drain due jobs */
      }
    } catch (err) {
      this.deps.logger.warn(
        { err: err instanceof Error ? err.name : 'error' },
        'evaluation tick failed',
      );
    } finally {
      this.running = false;
    }
  }

  /** Claims and processes one due job. Returns false when nothing was due. */
  async runOnce(): Promise<boolean> {
    const job = await this.deps.jobs.claim(this.now(), this.owner, this.leaseMs());
    if (!job) return false;
    await this.process(job);
    return true;
  }

  private async process(job: EvaluationJobRecord): Promise<void> {
    const rec = await this.deps.store.findById(job.sessionId);
    if (
      !rec ||
      rec.status !== 'submitted' ||
      !(await this.deps.interviews.consentStillActive(rec))
    ) {
      await this.deps.jobs.cancel(job.sessionId, this.now());
      if (rec?.status === 'submitted' && rec.evaluationStatus !== 'succeeded')
        await this.deps.interviews.markEvaluation(rec.id, 'failed');
      return;
    }
    await this.deps.interviews.markEvaluation(rec.id, 'running');
    const steps: EvaluationSteps = structuredClone(job.steps);
    const save = async () => {
      const ok = await this.deps.jobs.saveSteps(
        job.id,
        this.owner,
        steps,
        new Date(this.now().getTime() + this.leaseMs()),
      );
      if (!ok) throw new StepFailure('lease_lost');
    };
    try {
      const proof: ConsentProof = {
        purpose: 'assessment',
        consentRecordId: rec.consentRecordId!,
        policyVersion: rec.consent!.policyVersion,
      };
      const candidate = await this.deps.identity.findUserById(rec.candidateUserId);
      const names = candidate ? [candidate.displayName] : [];
      const redact = (s: string) => redactForAi(s, { knownNames: names }).text;

      for (const turn of questionTurns(rec.turns)) {
        if (!turn.answer || steps.answers[String(turn.index)]) continue;
        steps.answers[String(turn.index)] = turn.answer.skipped
          ? skippedRecord()
          : await this.evaluateAnswer(rec, turn, redact, proof);
        await save();
      }
      if (!steps.communication) {
        steps.communication = await this.evaluateCommunication(rec, redact, proof);
        await save();
      }
      if (rec.coding && !steps.codeGrade) {
        steps.codeGrade = await this.gradeCode(rec, job.attempts >= job.maxAttempts);
        await save();
      }
      if (rec.coding && !steps.codeReview) {
        steps.codeReview = await this.reviewCode(rec, steps, proof);
        await save();
      }

      // Consent can be withdrawn while the job runs: re-check before committing anything.
      const latest = await this.deps.store.findById(rec.id);
      if (
        !latest ||
        !consentActive(latest) ||
        !(await this.deps.interviews.consentStillActive(latest))
      ) {
        await this.deps.jobs.cancel(rec.id, this.now());
        return;
      }
      const previous = await this.deps.reports.findLatest(rec.id);
      const version = (previous?.version ?? 0) + 1;
      const data = buildReport(latest, steps, {
        candidate: partyOf(candidate ?? null),
        reportVersion: version,
        now: this.now(),
      });
      const report = await this.deps.reports.insert({
        id: new mongoose.Types.ObjectId().toHexString(),
        sessionId: rec.id,
        version,
        rubricVersion: RUBRIC_VERSION,
        generatedAt: this.now(),
        data,
      });
      await this.deps.interviews.markEvaluation(rec.id, 'succeeded', report.id);
      await this.deps.jobs.finish(job.id, this.owner, 'succeeded', null, this.now());
      this.deps.logger.info({ interview: rec.id, reportVersion: version }, 'interview evaluated');
    } catch (err) {
      const code = err instanceof StepFailure ? err.code : 'internal_error';
      if (code === 'lease_lost' || code === 'consent_missing') {
        if (code === 'consent_missing') await this.deps.jobs.cancel(rec.id, this.now());
        // Withdrawal can race with this run's "running" mark; never leave it standing.
        const latest = await this.deps.store.findById(rec.id);
        if (
          latest &&
          latest.evaluationStatus === 'running' &&
          !(await this.deps.interviews.consentStillActive(latest))
        )
          await this.deps.interviews.markEvaluation(rec.id, 'failed');
        return;
      }
      // Keep finished steps; back off and retry, or fail once the budget is spent.
      await this.deps.jobs
        .saveSteps(job.id, this.owner, steps, new Date(this.now().getTime() + this.leaseMs()))
        .catch(() => false);
      if (job.attempts < job.maxAttempts && code !== 'disabled') {
        const base = this.deps.jobBackoffMs ?? 10_000;
        const delay = base * 4 ** (job.attempts - 1);
        await this.deps.jobs.reschedule(
          job.id,
          this.owner,
          new Date(this.now().getTime() + delay),
          code,
        );
        await this.deps.interviews.markEvaluation(rec.id, 'queued');
        this.deps.logger.warn(
          { interview: rec.id, code, attempts: job.attempts },
          'evaluation rescheduled',
        );
      } else {
        await this.deps.jobs.finish(job.id, this.owner, 'failed', code, this.now());
        await this.deps.interviews.markEvaluation(rec.id, 'failed');
        this.deps.logger.warn(
          { interview: rec.id, code, attempts: job.attempts },
          'evaluation failed',
        );
      }
    }
  }

  /**
   * The lease is renewed after every saved step, so it must outlast the slowest step: one AI
   * call with all retries, or the sandbox grading run (120 s), plus a margin.
   */
  private leaseMs(): number {
    const t = this.callTiming();
    return Math.max(MIN_LEASE_MS, worstCaseCallMs(t.timeoutMs, t.retry) + 60_000, 180_000);
  }

  private callTiming() {
    return {
      timeoutMs: Math.max(this.deps.aiCall.timeoutMs, 30_000),
      retry: { attempts: this.deps.aiCall.maxAttempts, baseDelayMs: 2_000, maxDelayMs: 30_000 },
    };
  }

  private common(proof: ConsentProof) {
    return {
      ...this.callTiming(),
      logger: this.deps.logger,
      consent: proof,
      ...(this.deps.sleep ? { sleep: (ms: number) => this.deps.sleep!(ms) } : {}),
    };
  }

  private provenance(meta: {
    providerId: string;
    model: string | null;
    promptVersion: string;
  }): StepProvenance {
    return {
      provider: meta.providerId,
      model: meta.model,
      promptVersion: meta.promptVersion,
      evaluatedAt: this.now().toISOString(),
    };
  }

  private fail(code: ProviderErrorCode): never {
    throw new StepFailure(code);
  }

  private async evaluateAnswer(
    rec: InterviewRecord,
    turn: TurnRecord,
    redact: (s: string) => string,
    proof: ConsentProof,
  ): Promise<AnswerEvaluationRecord> {
    const answerText = cut(redact(turn.answer!.text), ANSWER_CHARS);
    const related: Array<{ prompt: string; answer: string }> = [];
    let parent = turn.parentIndex;
    while (parent !== null && related.length < 2) {
      const p = rec.turns.find((t) => t.index === parent);
      if (!p) break;
      related.unshift({
        prompt: p.prompt,
        answer: cut(redact(p.answer?.text ?? ''), CONTEXT_CHARS),
      });
      parent = p.parentIndex;
    }
    const res = await invokeCapability(
      this.deps.ai,
      'answer_evaluation',
      {
        contractVersion: INTERVIEW_CONTRACT_VERSION,
        roleKey: ROLE_KEY,
        language: 'en',
        rubricVersion: RUBRIC_VERSION,
        rubric: rubricInput(TECHNICAL_RUBRIC) as never,
        question: {
          type: turn.questionType!,
          topic: turn.topic ?? '',
          difficulty: turn.difficulty ?? 2,
          prompt: turn.prompt,
          expectedConcepts: turn.expectedConcepts,
          resumeEvidence: turn.resumeEvidence,
        },
        roleSkills: rec.briefFull.requiredSkills.map((s) => s.skillId),
        answer: {
          text: answerText,
          inputMode: turn.answer!.inputMode,
          transcriptConfidence: turn.answer!.transcriptConfidence,
          uncertainSegments: turn.answer!.uncertainSegments,
          edited: turn.answer!.edited,
        },
        relatedHistory: related,
      },
      { ...this.common(proof), outputSchema: answerEvaluationSchema },
    );
    if (!res.ok) this.fail(res.error.code);
    const v = res.value;
    const { dims, downgraded } = enforceEvidence(v.dimensions, answerText);
    const quoted = (q: string) =>
      answerText
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .includes(q.toLowerCase().replace(/\s+/g, ' ').trim());
    return {
      status: 'evaluated',
      notAssessedReason:
        dims.correctness.level === null
          ? 'Correctness could not be assessed from the answer.'
          : null,
      dimensions: dims,
      downgradedDimensions: downgraded,
      conceptsDemonstrated: v.conceptsDemonstrated,
      conceptsMissing: v.conceptsMissing,
      incorrectStatements: v.incorrectStatements.filter((s) => quoted(s.quote)),
      strengths: v.strengths.filter((s) => quoted(s.evidence)),
      gaps: v.gaps,
      uncertainty:
        downgraded.length > 0
          ? {
              level: v.uncertainty.level === 'low' ? 'medium' : v.uncertainty.level,
              reasons: [
                ...v.uncertainty.reasons,
                `${downgraded.length} judgment(s) lacked quoted evidence and were discarded.`,
              ].slice(0, 5),
            }
          : v.uncertainty,
      transcriptionIssuesSuspected: v.transcriptionIssuesSuspected,
      provenance: this.provenance(res.meta),
    };
  }

  private async evaluateCommunication(
    rec: InterviewRecord,
    redact: (s: string) => string,
    proof: ConsentProof,
  ) {
    const answers = questionTurns(rec.turns)
      .filter((t) => t.answer && !t.answer.skipped && t.answer.text.trim().length > 0)
      .slice(0, 10)
      .map((t) => ({
        index: t.index,
        prompt: t.prompt,
        text: cut(redact(t.answer!.text), 1_500),
        inputMode: t.answer!.inputMode,
        transcriptConfidence: t.answer!.transcriptConfidence,
      }));
    if (answers.length === 0) {
      return {
        status: 'not_assessed' as const,
        notAssessedReason: 'No answers to assess.',
        dimensions: null,
        overallFeedback: '',
        strengths: [],
        suggestions: [],
        provenance: null,
      };
    }
    const res = await invokeCapability(
      this.deps.ai,
      'communication_evaluation',
      {
        contractVersion: INTERVIEW_CONTRACT_VERSION,
        roleKey: ROLE_KEY,
        language: 'en',
        rubricVersion: RUBRIC_VERSION,
        rubric: rubricInput(COMMUNICATION_RUBRIC) as never,
        answers,
      },
      { ...this.common(proof), outputSchema: communicationEvaluationSchema },
    );
    if (!res.ok) this.fail(res.error.code);
    const { dims } = enforceEvidence(res.value.dimensions, answers.map((a) => a.text).join('\n'));
    return {
      status: 'evaluated' as const,
      notAssessedReason: null,
      dimensions: dims,
      overallFeedback: res.value.overallFeedback,
      strengths: res.value.strengths,
      suggestions: res.value.suggestions,
      provenance: this.provenance(res.meta),
    };
  }

  /**
   * Deterministic tests in the sandbox. A sandbox fault (outage or Judge0 internal error) is
   * never scored as the candidate's failure: it is retried with the job and, on the last
   * attempt, recorded as `failed` with no tests so the report carries no coding score.
   */
  private async gradeCode(rec: InterviewRecord, finalAttempt: boolean) {
    const sub = rec.coding!.submission;
    const task = findTask(rec.coding!.taskId);
    const at = this.now().toISOString();
    if (!sub || !task || sub.code.trim() === '') {
      return {
        status: 'not_run' as const,
        message: 'No solution was submitted.',
        compileError: false,
        diagnostics: null,
        tests: [],
        judge: this.deps.judge.providerId,
        gradedAt: at,
      };
    }
    if (!this.deps.judge.available) {
      return {
        status: 'unavailable' as const,
        message: this.deps.judge.unavailableReason,
        compileError: false,
        diagnostics: null,
        tests: [],
        judge: this.deps.judge.providerId,
        gradedAt: at,
      };
    }
    const sandboxFailed = (message: string) => {
      if (!finalAttempt) throw new StepFailure('judge_unavailable');
      return {
        status: 'failed' as const,
        message,
        compileError: false,
        diagnostics: null,
        tests: [],
        judge: this.deps.judge.providerId,
        gradedAt: at,
      };
    };
    let g;
    try {
      g = await gradeSubmission(
        this.deps.judge,
        task,
        sub.language,
        sub.code,
        AbortSignal.timeout(120_000),
      );
    } catch (err) {
      if (err instanceof JudgeUnavailableError)
        return sandboxFailed('The code execution sandbox could not be reached.');
      throw err;
    }
    if (g.status === 'internal_error')
      return sandboxFailed('The code execution sandbox reported an internal error.');
    // Hidden test names describe their inputs, so reports show them generically.
    let hidden = 0;
    return {
      status: 'executed' as const,
      message: null,
      compileError: g.compileError,
      diagnostics: g.diagnostics,
      tests: g.tests.map((t) => ({
        name: t.category === 'hidden' ? `Hidden check ${++hidden}` : t.name,
        category: t.category,
        outcome: t.outcome,
      })),
      judge: this.deps.judge.providerId,
      gradedAt: at,
    };
  }

  private async reviewCode(rec: InterviewRecord, steps: EvaluationSteps, proof: ConsentProof) {
    const sub = rec.coding!.submission;
    const task = findTask(rec.coding!.taskId);
    if (!sub || !task || sub.code.trim() === '') {
      return {
        status: 'not_assessed' as const,
        notAssessedReason: 'No solution was submitted.',
        dimensions: null,
        explanationFeedback: '',
        improvements: [],
        issues: [],
        summary: '',
        provenance: null,
      };
    }
    const code = redactForAi(sub.code).text;
    const grade = steps.codeGrade!;
    const res = await invokeCapability(
      this.deps.ai,
      'code_review',
      {
        contractVersion: INTERVIEW_CONTRACT_VERSION,
        roleKey: ROLE_KEY,
        language: 'en',
        rubricVersion: RUBRIC_VERSION,
        rubric: rubricInput(CODE_REVIEW_RUBRIC) as never,
        task: { title: task.title, kind: task.kind, prompt: task.prompt, language: sub.language },
        code,
        explanation: cut(redactForAi(sub.explanation).text, 2_000),
        tests: {
          execution:
            grade.status === 'executed'
              ? 'executed'
              : grade.status === 'failed'
                ? 'failed'
                : 'unavailable',
          passed: grade.tests.filter((t) => t.outcome === 'passed').length,
          total: grade.tests.length,
          compileError: grade.compileError,
        },
      },
      { ...this.common(proof), outputSchema: codeReviewSchema },
    );
    if (!res.ok) this.fail(res.error.code);
    const lines = code.split('\n').length;
    const { dims } = enforceEvidence(res.value.dimensions, code);
    return {
      status: 'evaluated' as const,
      notAssessedReason: null,
      dimensions: dims,
      explanationFeedback: res.value.explanationFeedback,
      improvements: res.value.improvements,
      issues: res.value.issues.filter((i) => i.line === null || i.line <= lines),
      summary: res.value.summary,
      provenance: this.provenance(res.meta),
    };
  }
}

function skippedRecord(): AnswerEvaluationRecord {
  return {
    status: 'skipped',
    notAssessedReason: null,
    dimensions: null,
    downgradedDimensions: [],
    conceptsDemonstrated: [],
    conceptsMissing: [],
    incorrectStatements: [],
    strengths: [],
    gaps: [],
    uncertainty: null,
    transcriptionIssuesSuspected: false,
    provenance: null,
  };
}
