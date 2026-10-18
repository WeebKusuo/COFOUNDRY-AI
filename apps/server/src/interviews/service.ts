import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import {
  INTERVIEW_CONSENT_POLICY_VERSION,
  INTERVIEW_CONTRACT_VERSION,
  INTERVIEW_INTRO_TEXT,
  INTERVIEW_LIMITS as L,
  LIVE_STATUSES,
  ROLE_KEY,
  VERSIONS,
  VOICE_TEST_TEXT,
  isSupportedAudioType,
  looksLikePromptInjection,
  missingInterviewConsents,
  redactForAi,
  baseContentType,
  type AnswerSubmitRequest,
  type CancellationReason,
  type CodeLanguage,
  type InterviewAcceptRequest,
  type InterviewReadiness,
  type InterviewSessionView,
  type InterviewStatus,
  type InterviewSummary,
  type QuestionPreparation,
  type ReportResponse,
  type ResumeRef,
  type SkipReason,
} from '@cofoundry/shared';
import {
  checkQuestionPlan,
  checkTaskSelection,
  checkTurnPolicy,
  codingTaskSelectionSchema,
  filterResumeContext,
  interviewTurnOutputSchema,
  invokeCapability,
  normalizeForQuote,
  promptSimilarity,
  questionPlanOutputSchema,
  REPEAT_SIMILARITY_THRESHOLD,
  resumeContextSchema,
  type AiLogger,
  type AiProviderRegistry,
  type ConsentProof,
  type InterviewTurnInput,
  type InterviewTurnOutput,
  type RetryPolicy,
  worstCaseCallMs,
} from '../ai/index.js';
import type { IdentityStore, UserRecord } from '../auth/store.js';
import type { BriefStore } from '../briefs/store.js';
import type { BriefService } from '../briefs/service.js';
import { toBriefData } from '../briefs/service.js';
import { runVisibleTests } from '../coding/grading.js';
import { JudgeUnavailableError, type CodeJudge } from '../coding/judge.js';
import { CODING_TASKS, findTask, ruleBasedTask } from '../coding/tasks.js';
import { AppError } from '../http/errors.js';
import { evaluateCandidate, prepareBrief } from '../matching/engine.js';
import type { ProfileStore } from '../profiles/store.js';
import type { RecommendationService } from '../recommendations/service.js';
import { toMatchBrief, toMatchCandidate } from '../recommendations/service.js';
import type { ResumeService } from '../resumes/service.js';
import { SpeechError, analyseTranscript, editRatio, type SpeechServices } from '../speech/types.js';
import {
  answeredCount,
  computeTurnPolicy,
  conversationMustEnd,
  historyForPrompt,
  openedTopics,
  questionPlanSlots,
  questionTurns,
} from './policy.js';
import {
  IDLE_GENERATION,
  type CodingRecord,
  type GenerationPurpose,
  type InterviewRecord,
  type PlannedQuestionRecord,
  type TurnRecord,
} from './records.js';
import type { StoredReport } from './report.js';
import { prepareResumeForInterview, readinessOf, type PreparedResume } from './resume.js';
import type { EvaluationJobStore, InterviewStore, ReportStore } from './store.js';
import {
  consentActive,
  partyOf,
  toSessionView,
  toSummary,
  viewerRole,
  type ViewerRole,
} from './view.js';

export interface InterviewServiceDeps {
  store: InterviewStore;
  jobs: EvaluationJobStore;
  reports: ReportStore;
  briefStore: BriefStore;
  briefs: BriefService;
  identity: IdentityStore;
  profiles: ProfileStore;
  recommendations: RecommendationService;
  resumes: ResumeService;
  ai: AiProviderRegistry;
  aiCall: { timeoutMs: number; maxAttempts: number };
  speech: SpeechServices;
  judge: CodeJudge;
  logger: AiLogger & { error?(obj: Record<string, unknown>, msg: string): void };
  now?: () => Date;
  /** Injected for tests (retry backoff). */
  sleep?: (ms: number) => Promise<void>;
}

const notFound = () => new AppError('NOT_FOUND', 'The requested resource was not found.');
const invalid = (message: string) => new AppError('INVALID_STATE', message);

/**
 * Phase 14 hooks, attached after construction (the safety service depends on this one): block
 * checks at action boundaries, report overlays (corrections, quarantine), dispute holds that
 * pause retention for the held session, and the audit trail for founder report reads.
 */
export interface InterviewSafetyHooks {
  isBlocked(a: string, b: string): Promise<boolean>;
  reportOverlays(interviewId: string): Promise<{
    corrections: Array<{ caseId: string; text: string; at: string; by: 'CoFoundry moderator' }>;
    openCorrections: number;
  }>;
  heldSessionIds(): Promise<Set<string>>;
  auditReportRead(actorId: string, interviewId: string): Promise<void>;
}

export const QUARANTINE_NOTICE =
  'A moderator quarantined this report after a dispute. The AI-written narrative is hidden and ' +
  'the report cannot support new collaboration requests; the source answers, code and numbers ' +
  'remain visible.';

/** Removes AI-written narrative from a quarantined report (answers, code and numbers stay). */
export function withoutNarrative(r: StoredReport): StoredReport {
  const blankDims = <T extends Record<string, { rationale: string; evidence: string[] }> | null>(
    d: T,
  ): T =>
    (d
      ? Object.fromEntries(
          Object.entries(d).map(([k, v]) => [k, { ...v, rationale: '', evidence: [] }]),
        )
      : d) as T;
  return {
    ...r,
    questions: r.questions.map((q) => ({
      ...q,
      dimensions: blankDims(q.dimensions),
      conceptsDemonstrated: [],
      conceptsMissing: [],
      incorrectStatements: [],
      strengths: [],
      gaps: [],
      uncertainty: null,
    })),
    resumeUnderstanding: { ...r.resumeUnderstanding, notes: [] },
    strengths: [],
    knowledgeGaps: [],
    communication: {
      ...r.communication,
      dimensions: blankDims(r.communication.dimensions),
      overallFeedback: '',
      strengths: [],
      suggestions: [],
    },
    coding: r.coding
      ? {
          ...r.coding,
          review: {
            ...r.coding.review,
            dimensions: blankDims(r.coding.review.dimensions),
            explanationFeedback: '',
            improvements: [],
            issues: [],
            summary: '',
          },
        }
      : null,
  };
}
/** Fallback generation lease when no AI timing is known (reconcile callers outside the service). */
const DEFAULT_GENERATION_LEASE_MS = 120_000;
const EVALUATION_MAX_ATTEMPTS = 4;
/** Failed preparations in a row before retries pause for PREPARATION_COOLDOWN_MS (AI cost bound). */
const MAX_PREPARATION_FAILURES = 10;
const PREPARATION_COOLDOWN_MS = 60 * 60_000;

type Mutator = (rec: InterviewRecord, now: Date) => InterviewRecord | null;

function clone<T>(v: T): T {
  return structuredClone(v);
}

function startGeneration(
  rec: InterviewRecord,
  purpose: GenerationPurpose,
  now: Date,
  leaseMs: number,
): InterviewRecord {
  return {
    ...rec,
    generation: {
      status: 'running',
      purpose,
      token: randomUUID(),
      leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
      failures: rec.generation.failures,
      lastErrorCode: null,
    },
  };
}

/** Marks the open question (if any) skipped; returns a new turns array. */
function skipOpenQuestion(turns: TurnRecord[], reason: SkipReason, now: Date): TurnRecord[] {
  return turns.map((t) =>
    t.kind === 'question' && !t.answer
      ? {
          ...t,
          draft: null,
          answer: {
            text: '',
            inputMode: 'typed',
            transcriptOriginal: null,
            transcriptConfidence: null,
            uncertainSegments: 0,
            edited: false,
            editRatio: null,
            skipped: true,
            skipReason: reason,
            submittedAt: now.toISOString(),
            injectionSuspected: false,
          },
        }
      : t,
  );
}

function submitted(rec: InterviewRecord, now: Date): InterviewRecord {
  return {
    ...rec,
    status: 'submitted',
    submittedAt: now,
    evaluationStatus: 'queued',
    generation: { ...IDLE_GENERATION },
  };
}

function ruleBasedCoding(rec: InterviewRecord, now: Date): CodingRecord {
  const task = ruleBasedTask(rec.briefFull.requiredSkills.map((s) => s.skillId));
  return codingRecordFor(rec, task.id, task.version, now, {
    method: 'rule_based',
    reason: 'Chosen by skill overlap with the role because the AI task selection was unavailable.',
    provider: null,
    model: null,
  });
}

function codingRecordFor(
  rec: InterviewRecord,
  taskId: string,
  taskVersion: string,
  now: Date,
  selection: CodingRecord['selection'],
): CodingRecord {
  const deadline = new Date(
    Math.min(now.getTime() + L.codingSeconds * 1000, rec.globalDeadline!.getTime()),
  );
  return {
    taskId,
    taskVersion,
    selection,
    startedAt: now.toISOString(),
    deadline: deadline.toISOString(),
    draft: null,
    runs: [],
    runCount: 0,
    submission: null,
  };
}

function sameResume(a: ResumeRef | null, b: ResumeRef): boolean {
  return (
    !!a &&
    a.resumeVersion === b.resumeVersion &&
    a.textSha256 === b.textSha256 &&
    a.extractorVersion === b.extractorVersion
  );
}

function preparationFailureMessage(code: string | null): string {
  switch (code) {
    case 'consent_missing':
      return 'Interview consent is no longer active, so questions cannot be prepared.';
    case 'resume_missing':
      return 'Your resume could not be read. Upload it again and retry.';
    case 'rate_limited':
      return 'The AI provider is busy right now. Retry in a minute.';
    case 'timeout':
    case 'interrupted':
      return 'Preparing the questions took too long. Retry in a moment.';
    case 'invalid_output':
      return 'The AI returned questions that did not pass our checks. Retry to prepare them again.';
    default:
      return 'The questions could not be prepared. Retry in a moment.';
  }
}

/** Candidate-facing state of the question plan for the current resume. */
export function preparationOf(rec: InterviewRecord, prepared: PreparedResume): QuestionPreparation {
  const plan = rec.questionPlan ?? null;
  const ctx = rec.resumeContext;
  const basedOn =
    plan && ctx
      ? {
          projects: ctx.projects.map((p) => p.name).slice(0, 8),
          technologies: [
            ...new Set([...ctx.projects.flatMap((p) => p.technologies), ...ctx.skills]),
          ].slice(0, 16),
        }
      : null;
  const base = {
    plannedCount: plan?.length ?? 0,
    basedOn,
    resumeVersion: plan ? (rec.resumeRef?.resumeVersion ?? null) : null,
  };
  if (LIVE_STATUSES.has(rec.status)) return { status: 'ready', ...base, message: null };
  if (!prepared.ready) {
    return {
      status: 'waiting_for_resume',
      plannedCount: 0,
      basedOn: null,
      resumeVersion: null,
      message: 'Add your resume first: the interview questions are prepared from it.',
    };
  }
  const g = rec.generation;
  if (g.purpose === 'preparation' && g.status === 'running') {
    return {
      status: 'preparing',
      ...base,
      message: 'Reading your resume and preparing questions from your projects and tech stack…',
    };
  }
  if (plan && sameResume(rec.resumeRef, prepared.ref)) {
    return { status: 'ready', ...base, message: null };
  }
  if (plan) {
    return {
      status: 'stale',
      ...base,
      message:
        'Your resume changed after the questions were prepared, so they need preparing again.',
    };
  }
  if (g.purpose === 'preparation' && g.status === 'failed') {
    return { status: 'failed', ...base, message: preparationFailureMessage(g.lastErrorCode) };
  }
  return { status: 'not_started', ...base, message: 'The questions have not been prepared yet.' };
}

/**
 * Deadline and lease reconciliation (v3.0 Section 07 timing, superseded flow). Called before every
 * read and mutation and by the 15-second sweeper; disconnect time never extends anything.
 * Returns null when nothing changes.
 */
export function reconcileRecord(
  rec: InterviewRecord,
  now: Date,
  generationLeaseMs = DEFAULT_GENERATION_LEASE_MS,
): InterviewRecord | null {
  let next: InterviewRecord | null = null;
  const t = now.getTime();
  if ((rec.status === 'invited' || rec.status === 'accepted') && t >= rec.expiresAt.getTime()) {
    return { ...rec, status: 'expired', activeClientId: null, generation: { ...IDLE_GENERATION } };
  }
  if (rec.status === 'accepted') {
    // An interrupted preparation (process restart) becomes a retryable failure.
    const g = rec.generation;
    if (g.status === 'running' && g.leaseUntil && t >= Date.parse(g.leaseUntil)) {
      return {
        ...rec,
        generation: {
          ...g,
          status: 'failed',
          token: null,
          leaseUntil: null,
          failures: g.failures + 1,
          lastErrorCode: 'interrupted',
          failedAt: now.toISOString(),
        },
      };
    }
    return null;
  }
  if (rec.status === 'in_progress') {
    const global = rec.globalDeadline!.getTime();
    const conversation = rec.conversationDeadline!.getTime();
    if (t >= global || t >= conversation) {
      const reason: SkipReason = t >= global ? 'session_timeout' : 'conversation_timeout';
      const turns = skipOpenQuestion(rec.turns, reason, now);
      if (t >= global) return submitted({ ...rec, turns }, now);
      const coding = startGeneration(
        { ...rec, turns, status: 'coding', coding: null },
        'coding_setup',
        now,
        generationLeaseMs,
      );
      return { ...coding, codingDeadline: null };
    }
    const g = rec.generation;
    if (g.status === 'running' && g.leaseUntil && t >= Date.parse(g.leaseUntil)) {
      next = {
        ...rec,
        generation: {
          ...g,
          status: 'failed',
          token: null,
          leaseUntil: null,
          failures: g.failures + 1,
          lastErrorCode: 'interrupted',
        },
      };
    }
    return next;
  }
  if (rec.status === 'coding') {
    let cur = rec;
    const g = cur.generation;
    if (!cur.coding && g.status === 'running' && g.leaseUntil && t >= Date.parse(g.leaseUntil)) {
      const coding = ruleBasedCoding(cur, now);
      cur = {
        ...cur,
        coding,
        codingDeadline: new Date(coding.deadline),
        generation: { ...IDLE_GENERATION },
      };
      next = cur;
    }
    const deadline = cur.codingDeadline?.getTime() ?? Infinity;
    if (t >= cur.globalDeadline!.getTime() || t >= deadline) {
      const coding = cur.coding
        ? {
            ...cur.coding,
            submission:
              cur.coding.submission ??
              (cur.coding.draft
                ? {
                    language: cur.coding.draft.language,
                    code: cur.coding.draft.code,
                    explanation: cur.coding.draft.explanation ?? '',
                    submittedAt: now.toISOString(),
                    autoSubmitted: true,
                  }
                : null),
          }
        : null;
      return submitted({ ...cur, coding }, now);
    }
    return next;
  }
  if (rec.status === 'submitted' && rec.evaluationStatus === 'none') {
    return { ...rec, evaluationStatus: 'queued' };
  }
  return null;
}

/**
 * Interview lifecycle (Phase 7) and live interview (Phases 8-9): invitations, consent, readiness,
 * the explicit conversation state machine, transcription, coding round and submission. The
 * evaluation worker and report live in evaluation.ts / report.ts.
 */
export class InterviewService {
  private readonly now: () => Date;
  private readonly pending = new Set<Promise<void>>();
  private healthCache: { at: number; value: Awaited<ReturnType<SpeechServices['health']>> } | null =
    null;
  private readonly ttsCache = new Map<string, { at: number; wav: Buffer }>();

  private safety: InterviewSafetyHooks | null = null;

  constructor(private readonly deps: InterviewServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    deps.resumes.onChanged((userId) => this.onResumeChanged(userId));
  }

  /**
   * The candidate replaced or deleted their resume: accepted (not yet started) interviews drop
   * everything prepared from the previous version — resume text, context and question plan — and
   * stop a running preparation (its late result is discarded by the token check). The readiness
   * screen then prepares again from the current resume, if there is one.
   */
  async onResumeChanged(candidateUserId: string): Promise<void> {
    let after: { invitedAt: Date; id: string } | null = null;
    for (let page = 0; page < 20; page += 1) {
      const batch = await this.deps.store.list(
        { candidateUserId, status: 'accepted' },
        { after, limit: 50 },
      );
      for (const r of batch) {
        await this.mutate(r.id, (cur) =>
          cur.status !== 'accepted' || (!cur.resumeTextForAi && cur.generation.status !== 'running')
            ? null
            : {
                ...cur,
                resumeRef: null,
                resumeTextForAi: null,
                resumeContext: null,
                resumeInjectionSuspected: false,
                questionPlan: null,
                preparedAt: null,
                generation: { ...IDLE_GENERATION, failures: cur.generation.failures },
              },
        ).catch(() => undefined);
      }
      if (batch.length < 50) return;
      const last = batch[batch.length - 1]!;
      after = { invitedAt: last.invitedAt, id: last.id };
    }
  }

  attachSafety(hooks: InterviewSafetyHooks): void {
    this.safety = hooks;
  }

  private async assertNotBlocked(rec: InterviewRecord): Promise<void> {
    if (rec.blockedAt || (await this.safety?.isBlocked(rec.founderUserId, rec.candidateUserId)))
      throw invalid('This collaboration is no longer available.');
  }

  // --- Phase 11 / 14 integration -----------------------------------------------------------------

  /** Facts the collaboration request flow needs (never answer or report content). */
  async collaborationFacts(interviewId: string): Promise<{
    interviewId: string;
    founderUserId: string;
    candidateUserId: string;
    briefId: string;
    evaluated: boolean;
    consentActive: boolean;
    quarantined: boolean;
    blocked: boolean;
    reportVersion: number | null;
    overallScore: number | null;
    evidenceLevel: string | null;
  } | null> {
    if (!/^[a-f0-9]{24}$/.test(interviewId)) return null;
    const rec = await this.deps.store.findById(interviewId);
    if (!rec) return null;
    const evaluated =
      rec.status === 'submitted' && rec.evaluationStatus === 'succeeded' && !!rec.reportId;
    const stored = evaluated ? await this.deps.reports.findLatest(rec.id) : null;
    const data = stored?.data as StoredReport | undefined;
    return {
      interviewId: rec.id,
      founderUserId: rec.founderUserId,
      candidateUserId: rec.candidateUserId,
      briefId: rec.briefId,
      evaluated: evaluated && !!stored,
      consentActive: consentActive(rec),
      quarantined: !!rec.reportQuarantinedAt,
      blocked: !!rec.blockedAt,
      reportVersion: stored?.version ?? null,
      overallScore: data?.overall.score ?? null,
      evidenceLevel: data?.overall.evidenceLevel ?? null,
    };
  }

  /** Interview records between two users (either may be the founder). */
  async sessionsBetween(a: string, b: string): Promise<InterviewRecord[]> {
    const out: InterviewRecord[] = [];
    for (const [f, c] of [
      [a, b],
      [b, a],
    ] as const) {
      out.push(
        ...(await this.deps.store.list(
          { founderUserId: f, candidateUserId: c },
          { after: null, limit: 100 },
        )),
      );
    }
    return out;
  }

  /**
   * Block (or suspension) between a pair: pre-submit interviews are cancelled and the founder's
   * access to submitted assessment content ends. Records remain for the candidate and for
   * retention; unblocking does not restore anything.
   */
  async onRelationshipBlocked(
    a: string,
    b: string,
    reason: 'blocked' | 'account_suspended' = 'blocked',
  ): Promise<number> {
    let n = 0;
    for (const r of await this.sessionsBetween(a, b)) {
      await this.mutate(r.id, (cur, now) => {
        const pre = ['invited', 'accepted', 'in_progress', 'coding'].includes(cur.status);
        if (!pre && (cur.blockedAt || reason === 'account_suspended')) return null;
        const base = reason === 'blocked' ? { ...cur, blockedAt: cur.blockedAt ?? now } : cur;
        return pre ? this.cancelled(base, reason, null, now) : base;
      }).catch(() => undefined);
      n += 1;
    }
    return n;
  }

  /** Suspension (Section 21): the user's pre-submit interviews are cancelled. */
  async onUserSuspended(userId: string): Promise<number> {
    let n = 0;
    for (const key of ['founderUserId', 'candidateUserId'] as const) {
      let after: { invitedAt: Date; id: string } | null = null;
      for (;;) {
        const rows = await this.deps.store.list({ [key]: userId }, { after, limit: 100 });
        for (const r of rows.slice(0, 100)) {
          if (!['invited', 'accepted', 'in_progress', 'coding'].includes(r.status)) continue;
          await this.mutate(r.id, (cur, now) =>
            ['invited', 'accepted', 'in_progress', 'coding'].includes(cur.status)
              ? this.cancelled(cur, 'account_suspended', null, now)
              : null,
          ).catch(() => undefined);
          n += 1;
        }
        const last = rows[Math.min(rows.length, 100) - 1];
        if (rows.length <= 100 || !last) break;
        after = { invitedAt: last.invitedAt, id: last.id };
      }
    }
    return n;
  }

  /** Moderator decision (Section 21): quarantine prevents new requests and hides AI narrative. */
  async setReportQuarantine(interviewId: string): Promise<boolean> {
    const rec = await this.deps.store.findById(interviewId);
    if (!rec || rec.status !== 'submitted') return false;
    await this.mutate(interviewId, (cur, now) =>
      cur.reportQuarantinedAt ? null : { ...cur, reportQuarantinedAt: now },
    );
    return true;
  }

  /** Minimal evidence for an assigned moderator (no AI narrative needed to triage). */
  async moderatorEvidence(interviewId: string): Promise<{
    founderUserId: string;
    candidateUserId: string;
    evidence: Array<{ label: string; value: string }>;
  } | null> {
    if (!/^[a-f0-9]{24}$/.test(interviewId)) return null;
    const rec = await this.deps.store.findById(interviewId);
    if (!rec) return null;
    const stored = rec.reportId ? await this.deps.reports.findLatest(rec.id) : null;
    const data = stored?.data as StoredReport | undefined;
    const evidence: Array<{ label: string; value: string }> = [
      { label: 'Interview status', value: `${rec.status} / evaluation ${rec.evaluationStatus}` },
      { label: 'Brief', value: rec.briefPreview?.title ?? rec.briefId },
    ];
    if (data) {
      evidence.push({
        label: 'Overall (rubric-computed)',
        value: `${data.overall.score ?? 'none'} — ${data.overall.evidenceLevel}`,
      });
      for (const q of data.questions) {
        evidence.push({
          label: `Q${q.index} ${q.status}${q.score === null ? '' : ` (${q.score})`}`,
          value: `${q.prompt}\nAnswer: ${q.answer?.skipped ? '[skipped]' : (q.answer?.text ?? '')}`,
        });
      }
    }
    return { founderUserId: rec.founderUserId, candidateUserId: rec.candidateUserId, evidence };
  }

  /** Resolves when background generation started by earlier calls has finished (tests). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  // --- helpers ----------------------------------------------------------------------------------

  /**
   * Question generation makes up to two AI calls (resume context, then the turn) plus storage
   * round-trips; the lease covers their worst case with a margin.
   */
  private generationLeaseMs(): number {
    return 2 * worstCaseCallMs(this.deps.aiCall.timeoutMs, this.retryPolicy()) + 30_000;
  }

  private retryPolicy(): RetryPolicy {
    return { attempts: this.deps.aiCall.maxAttempts, baseDelayMs: 1_000, maxDelayMs: 20_000 };
  }

  private sleepOpt() {
    const s = this.deps.sleep;
    return s ? { sleep: (ms: number) => s(ms) } : {};
  }

  private async load(id: string): Promise<InterviewRecord> {
    if (!mongoose.isValidObjectId(id) || !/^[a-f0-9]{24}$/.test(id)) throw notFound();
    const rec = await this.deps.store.findById(id);
    if (!rec) throw notFound();
    return rec;
  }

  private async access(
    user: UserRecord,
    id: string,
  ): Promise<{ rec: InterviewRecord; role: ViewerRole }> {
    const rec = await this.load(id);
    const role = viewerRole(user, rec);
    if (!role) throw notFound();
    return { rec: await this.reconciled(rec), role };
  }

  /** Applies due transitions, retrying on concurrent writes. */
  private async reconciled(rec: InterviewRecord): Promise<InterviewRecord> {
    let current = rec;
    for (let i = 0; i < 5; i += 1) {
      const next = reconcileRecord(current, this.now(), this.generationLeaseMs());
      if (!next) return current;
      const saved = await this.deps.store.replace(next, current.rev);
      if (saved) {
        await this.afterCommit(current, saved);
        current = saved;
        continue;
      }
      current = await this.load(rec.id);
    }
    return current;
  }

  /**
   * Read-reconcile-modify-write with optimistic concurrency. `fn` returns the next record or null
   * for "no change"; it may throw AppError to reject. Conflicts re-run `fn` on fresh state.
   */
  private async mutate(id: string, fn: Mutator): Promise<InterviewRecord> {
    for (let i = 0; i < 6; i += 1) {
      const current = await this.reconciled(await this.load(id));
      const next = fn(clone(current), this.now());
      if (!next) return current;
      const saved = await this.deps.store.replace({ ...next, updatedAt: this.now() }, current.rev);
      if (saved) {
        await this.afterCommit(current, saved);
        return saved;
      }
    }
    throw new AppError('VERSION_CONFLICT', 'The interview changed at the same time. Try again.');
  }

  private async afterCommit(prev: InterviewRecord, next: InterviewRecord): Promise<void> {
    if (
      next.status === 'submitted' &&
      next.evaluationStatus === 'queued' &&
      prev.status !== 'submitted'
    ) {
      await this.enqueueEvaluation(next);
    }
    if (prev.status !== 'submitted' && next.status === 'submitted') {
      this.deps.logger.info({ interview: next.id }, 'interview submitted');
    }
    const g = next.generation;
    if (g.status === 'running' && g.token && g.token !== prev.generation.token) {
      this.background(
        g.purpose === 'coding_setup'
          ? this.runCodingSetup(next.id, g.token)
          : g.purpose === 'preparation'
            ? this.runPreparation(next.id, g.token)
            : this.runQuestionGeneration(next.id, g.token),
      );
    }
  }

  async enqueueEvaluation(rec: InterviewRecord): Promise<void> {
    const at = this.now();
    await this.deps.jobs.enqueue({
      id: new mongoose.Types.ObjectId().toHexString(),
      sessionId: rec.id,
      founderUserId: rec.founderUserId,
      status: 'queued',
      attempts: 0,
      maxAttempts: EVALUATION_MAX_ATTEMPTS,
      nextRunAt: at,
      leaseOwner: null,
      leaseUntil: null,
      lastErrorCode: null,
      steps: { answers: {}, communication: null, codeGrade: null, codeReview: null },
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
    });
  }

  private background(task: Promise<void>): void {
    const p = task.catch((err: unknown) => {
      this.deps.logger.warn(
        { err: err instanceof Error ? err.name : 'error' },
        'interview background task failed',
      );
    });
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private proofOf(rec: InterviewRecord): ConsentProof | null {
    if (!consentActive(rec) || !rec.consentRecordId) return null;
    return {
      purpose: 'assessment',
      consentRecordId: rec.consentRecordId,
      policyVersion: rec.consent!.policyVersion,
    };
  }

  /** Consent re-checked against the durable ConsentRecord before dispatch and before commit. */
  async consentStillActive(rec: InterviewRecord): Promise<boolean> {
    if (!consentActive(rec)) return false;
    return this.deps.profiles.hasActiveConsent({
      userId: rec.candidateUserId,
      purpose: 'assessment',
      targetId: rec.id,
    });
  }

  private requireLiveClient(rec: InterviewRecord, clientId: string | null): void {
    if (!clientId || rec.activeClientId !== clientId) {
      throw new AppError(
        'ACTIVE_ELSEWHERE',
        'This interview is open in another window or device. Continue it here to take over.',
      );
    }
  }

  private async parties(rec: InterviewRecord) {
    const users = await this.deps.identity.findUsersByIds([rec.candidateUserId, rec.founderUserId]);
    return {
      candidate: users.find((u) => u.id === rec.candidateUserId) ?? null,
      founder: users.find((u) => u.id === rec.founderUserId) ?? null,
    };
  }

  private async retryAllowed(rec: InterviewRecord): Promise<boolean> {
    return (
      rec.status === 'submitted' &&
      rec.evaluationStatus === 'failed' &&
      rec.manualRetriesUsed < L.manualEvaluationRetries &&
      consentActive(rec)
    );
  }

  private executionStatus() {
    return { available: this.deps.judge.available, message: this.deps.judge.unavailableReason };
  }

  async readiness(rec: InterviewRecord, candidate: UserRecord): Promise<InterviewReadiness> {
    const prepared = await prepareResumeForInterview(this.deps.resumes, rec.candidateUserId, [
      candidate.displayName,
    ]);
    const health = await this.speechHealth();
    const sttOk = this.deps.speech.stt.configured && (health?.stt.ready ?? false);
    const ttsOk = this.deps.speech.tts.configured && (health?.tts.ready ?? false);
    const aiOk = this.deps.ai.allEnabled();
    return {
      resume: readinessOf(prepared),
      questions: preparationOf(rec, prepared),
      speechToText: {
        available: sttOk,
        message: sttOk
          ? null
          : !this.deps.speech.stt.configured
            ? 'Voice answers are not set up on this server (the speech service is off). You will type your answers.'
            : health
              ? 'The speech-to-text model is not loaded on the speech service (check its log; the model downloads on first start). You can type your answers.'
              : 'The speech service is not responding right now. You can still type your answers.',
      },
      textToSpeech: {
        available: ttsOk,
        message: ttsOk
          ? null
          : !this.deps.speech.tts.configured
            ? 'The server voice is not set up on this server.'
            : health
              ? 'The speech service has no voice loaded (PIPER_VOICE).'
              : 'The server voice is not responding right now.',
      },
      interviewer: {
        available: aiOk,
        message: aiOk
          ? null
          : 'The AI interviewer is not configured on this server, so the interview cannot start yet.',
        providers: this.deps.ai.disclosedProviders(),
      },
      codeExecution: this.executionStatus(),
      approximateMinutes: Math.round((L.conversationSeconds + L.codingSeconds) / 60),
    };
  }

  private async speechHealth() {
    const now = Date.now();
    if (this.healthCache && now - this.healthCache.at < 30_000) return this.healthCache.value;
    const value = await this.deps.speech.health(AbortSignal.timeout(3_000));
    this.healthCache = { at: now, value };
    return value;
  }

  async view(
    user: UserRecord,
    rec: InterviewRecord,
    role: ViewerRole,
    clientId: string | null,
  ): Promise<InterviewSessionView> {
    // A live block hides assessment content from the founder even if the post-block hook that
    // stamps blockedAt has not run (yet).
    if (
      role === 'founder' &&
      !rec.blockedAt &&
      (await this.safety?.isBlocked(rec.founderUserId, rec.candidateUserId))
    ) {
      rec = { ...rec, blockedAt: this.now() };
    }
    const parties = await this.parties(rec);
    const readiness =
      role === 'candidate' && ['invited', 'accepted', 'in_progress', 'coding'].includes(rec.status)
        ? await this.readiness(rec, user)
        : null;
    const profile =
      role === 'candidate' && rec.status === 'invited'
        ? await this.deps.profiles.findCandidate(rec.candidateUserId)
        : null;
    const report = rec.reportId ? await this.deps.reports.findLatest(rec.id) : null;
    return toSessionView(rec, role, {
      parties,
      now: this.now(),
      clientId,
      readiness,
      execution: this.executionStatus(),
      currentProfileRevision: profile?.revision ?? null,
      retryAllowed: await this.retryAllowed(rec),
      reportAvailable: report !== null,
    });
  }

  // --- Phase 7: invitations ---------------------------------------------------------------------

  async create(
    founder: UserRecord,
    input: { briefId: string; candidateUserId: string; batchId: string },
    id: string,
  ): Promise<InterviewSessionView> {
    const existingSame = await this.deps.store.findById(id);
    if (existingSame) {
      if (existingSame.founderUserId !== founder.id) throw notFound();
      return this.view(founder, await this.reconciled(existingSame), 'founder', null);
    }
    if (input.candidateUserId === founder.id) {
      throw new AppError('BAD_REQUEST', 'You cannot invite yourself.');
    }
    // Ownership first: another founder's brief must not reveal whether a pair exists.
    const owned = await this.deps.briefStore.findById(input.briefId);
    if (!owned || owned.founderUserId !== founder.id) throw notFound();
    const pair = await this.deps.store.findByPair(input.briefId, input.candidateUserId);
    if (pair) {
      throw new AppError(
        'DUPLICATE_PAIR',
        'This candidate was already invited for this brief. Each pair gets one interview.',
      );
    }
    const now = this.now();
    const sent = await this.deps.store.countInvitedSince(
      founder.id,
      new Date(now.getTime() - 24 * 3600_000),
    );
    if (sent >= L.invitationsPerFounderPerDay) {
      throw new AppError('RATE_LIMITED', 'You can send at most 20 interview invitations per day.', {
        headers: { 'Retry-After': '3600' },
      });
    }
    // MAT-08 boundary: fresh batch, listed and still-visible candidate, same revision, gates pass.
    const resolved = await this.deps.recommendations.resolveForInvitation(founder, input);
    const brief = await this.deps.briefStore.findById(input.briefId);
    if (!brief || brief.status !== 'open')
      throw new AppError('STALE_RECOMMENDATION', 'The brief is no longer open.');
    const record: InterviewRecord = {
      id,
      rev: 0,
      briefId: brief.id,
      briefVersion: resolved.briefVersion,
      candidateUserId: input.candidateUserId,
      founderUserId: founder.id,
      recommendationBatchId: input.batchId,
      status: 'invited',
      evaluationStatus: 'none',
      invitedAt: now,
      expiresAt: new Date(now.getTime() + L.invitationTtlMs),
      briefPreview: await this.deps.briefs.preview(brief, founder),
      briefFull: toBriefData(brief),
      briefAccessAt: null,
      acceptedAt: null,
      declinedAt: null,
      declineReason: null,
      cancelledAt: null,
      cancellationReason: null,
      cancellationNote: null,
      consent: null,
      consentRecordId: null,
      profileSnapshot: null,
      resumeRef: null,
      resumeTextForAi: null,
      resumeContext: null,
      resumeInjectionSuspected: false,
      startedAt: null,
      conversationDeadline: null,
      globalDeadline: null,
      codingDeadline: null,
      submittedAt: null,
      turns: [],
      generation: { ...IDLE_GENERATION },
      coding: null,
      activeClientId: null,
      lastHeartbeatAt: null,
      manualRetriesUsed: 0,
      reportId: null,
      minimizedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const outcome = await this.deps.store.insert(record);
    if (outcome === 'duplicate_pair') {
      throw new AppError(
        'DUPLICATE_PAIR',
        'This candidate was already invited for this brief. Each pair gets one interview.',
      );
    }
    const stored = (await this.deps.store.findById(id))!;
    return this.view(founder, stored, 'founder', null);
  }

  async list(
    user: UserRecord,
    role: ViewerRole,
    query: {
      briefId?: string;
      status?: InterviewStatus;
      after: { invitedAt: Date; id: string } | null;
      limit: number;
    },
  ): Promise<{ items: InterviewSummary[]; next: { invitedAt: Date; id: string } | null }> {
    const records = await this.deps.store.list(
      {
        ...(role === 'founder' ? { founderUserId: user.id } : { candidateUserId: user.id }),
        ...(query.briefId ? { briefId: query.briefId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      { after: query.after, limit: query.limit },
    );
    const page = records.slice(0, query.limit);
    const reconciled = await Promise.all(page.map((r) => this.reconciled(r)));
    const ids = [...new Set(reconciled.flatMap((r) => [r.candidateUserId, r.founderUserId]))];
    const users = new Map((await this.deps.identity.findUsersByIds(ids)).map((u) => [u.id, u]));
    const now = this.now();
    const items = await Promise.all(
      reconciled.map(async (r) =>
        toSummary(
          r,
          role,
          {
            candidate: users.get(r.candidateUserId) ?? null,
            founder: users.get(r.founderUserId) ?? null,
          },
          now,
          await this.retryAllowed(r),
        ),
      ),
    );
    const last = page[page.length - 1];
    return {
      items,
      next:
        records.length > query.limit && last ? { invitedAt: last.invitedAt, id: last.id } : null,
    };
  }

  async get(user: UserRecord, id: string, clientId: string | null): Promise<InterviewSessionView> {
    const { rec, role } = await this.access(user, id);
    return this.view(user, rec, role, clientId);
  }

  /** Candidate actions inside a live interview also re-check blocks (Phase 14 boundary). */
  private async liveCandidate(user: UserRecord, id: string) {
    const rec = await this.asCandidate(user, id);
    await this.assertNotBlocked(rec);
    return rec;
  }

  private async asCandidate(user: UserRecord, id: string) {
    const { rec, role } = await this.access(user, id);
    if (role !== 'candidate')
      throw new AppError('FORBIDDEN', 'Only the invited candidate can do this.');
    return rec;
  }

  /** Confidentiality acknowledgement (v3.0 Section 06) — releases the full brief to the invitee. */
  async acknowledgeBrief(user: UserRecord, id: string): Promise<InterviewSessionView> {
    await this.asCandidate(user, id);
    const rec = await this.mutate(id, (r, now) => {
      if (r.briefAccessAt) return null;
      if (r.status !== 'invited') throw invalid('This invitation is no longer open.');
      return { ...r, briefAccessAt: now };
    });
    await this.deps.profiles.grantConsent(
      { userId: user.id, purpose: 'brief_access', targetId: rec.briefId },
      VERSIONS.confidentialityNotice,
      this.now(),
    );
    return this.view(user, rec, 'candidate', null);
  }

  async accept(
    user: UserRecord,
    id: string,
    body: InterviewAcceptRequest,
  ): Promise<InterviewSessionView> {
    const pre = await this.asCandidate(user, id);
    if (pre.status === 'accepted') return this.view(user, pre, 'candidate', null);
    if (pre.status !== 'invited') throw invalid('This invitation can no longer be accepted.');
    await this.assertNotBlocked(pre);
    if (!pre.briefAccessAt) throw invalid('Read and acknowledge the full brief before accepting.');
    if (body.briefVersion !== pre.briefVersion) {
      throw new AppError('VERSION_CONFLICT', 'The brief version does not match this invitation.');
    }
    if (body.consent.policyVersion !== INTERVIEW_CONSENT_POLICY_VERSION) {
      throw new AppError('VALIDATION_FAILED', 'Review the current consent notice.', {
        fieldErrors: { 'consent.policyVersion': ['Outdated consent notice.'] },
      });
    }
    const missing = missingInterviewConsents(body.consent.items);
    if (missing.length > 0) {
      throw new AppError('VALIDATION_FAILED', 'Required consents are missing.', {
        fieldErrors: Object.fromEntries(
          missing.map((m) => [`consent.items.${m}`, ['Required to take the interview.']]),
        ),
      });
    }
    if (!this.deps.ai.allEnabled()) {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'The AI interviewer is not configured on this server yet.',
      );
    }
    const brief = await this.deps.briefStore.findById(pre.briefId);
    if (!brief || brief.status !== 'open' || brief.version !== pre.briefVersion) {
      throw invalid('The brief closed or changed; this invitation can no longer be accepted.');
    }
    const profile = await this.deps.profiles.findCandidate(user.id);
    if (!profile || profile.revision !== body.profileRevision) {
      throw new AppError(
        'VERSION_CONFLICT',
        'Your profile changed. Review the profile you will share and accept again.',
      );
    }
    const candidate = toMatchCandidate({ user, profile });
    if (!candidate || !evaluateCandidate(prepareBrief(toMatchBrief(brief)), candidate).passed) {
      throw new AppError(
        'GATE_CHANGED',
        'Your profile no longer meets a mandatory requirement of this brief. Update your profile or decline.',
      );
    }
    const providers = this.deps.ai.disclosedProviders();
    const rec = await this.mutate(id, (r, now) => {
      if (r.status === 'accepted') return null;
      if (r.status !== 'invited') throw invalid('This invitation can no longer be accepted.');
      return {
        ...r,
        status: 'accepted',
        acceptedAt: now,
        consent: {
          policyVersion: INTERVIEW_CONSENT_POLICY_VERSION,
          items: { ...body.consent.items },
          grantedAt: now.toISOString(),
          disclosedProviders: providers,
          withdrawnAt: null,
        },
        consentRecordId: `${user.id}:assessment:${r.id}`,
        profileSnapshot: {
          revision: profile.revision,
          headline: profile.headline,
          skills: profile.skills.map((s) => ({ ...s })),
          projects: profile.projects.map((p) => ({
            title: p.title,
            description: p.description,
            skillTags: [...p.skillTags],
          })),
          availableHoursPerWeek: profile.availableHoursPerWeek,
          commitmentMonths: profile.commitmentMonths,
        },
      };
    });
    await this.deps.profiles.grantConsent(
      { userId: user.id, purpose: 'assessment', targetId: rec.id },
      INTERVIEW_CONSENT_POLICY_VERSION,
      this.now(),
    );
    // Start preparing the questions right away when the resume is ready (best-effort: the
    // readiness screen can always start or retry it).
    const prepared = await this.beginPreparation(user, rec.id).catch(() => rec);
    return this.view(user, prepared, 'candidate', null);
  }

  // --- Preparation: resume context and question plan before start ----------------------------

  /**
   * POST /interviews/:id/prepare — idempotent. Starts preparing the question plan from the
   * current resume unless a plan for that resume already exists or preparation is running.
   */
  async prepare(user: UserRecord, id: string): Promise<InterviewSessionView> {
    const pre = await this.asCandidate(user, id);
    if (pre.status !== 'accepted') {
      if (LIVE_STATUSES.has(pre.status)) return this.view(user, pre, 'candidate', null);
      throw invalid('Accept the invitation before preparing the interview.');
    }
    await this.assertNotBlocked(pre);
    if (!this.deps.ai.allEnabled()) {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'The AI interviewer is not configured on this server, so questions cannot be prepared.',
      );
    }
    if (!(await this.consentStillActive(pre)))
      throw invalid('Interview consent is no longer active.');
    const rec = await this.beginPreparation(user, id);
    return this.view(user, rec, 'candidate', null);
  }

  private async beginPreparation(user: UserRecord, id: string): Promise<InterviewRecord> {
    const prepared = await prepareResumeForInterview(this.deps.resumes, user.id, [
      user.displayName,
    ]);
    if (!prepared.ready) {
      const r = readinessOf(prepared);
      throw new AppError('RESUME_REQUIRED', r.ready ? 'Resume required.' : r.message);
    }
    if (!this.deps.ai.allEnabled()) return this.load(id);
    return this.mutate(id, (r, now) => {
      if (r.status !== 'accepted') return null;
      if (r.generation.status === 'running') return null;
      if (r.questionPlan && sameResume(r.resumeRef, prepared.ref)) return null;
      // Bound AI cost after repeated failures, but never lock the candidate out for good.
      let failures = r.generation.failures;
      if (failures >= MAX_PREPARATION_FAILURES) {
        const last = r.generation.failedAt ? Date.parse(r.generation.failedAt) : 0;
        if (now.getTime() - last < PREPARATION_COOLDOWN_MS) {
          throw new AppError(
            'RATE_LIMITED',
            'Preparing the questions failed several times. Try again in about an hour.',
            { headers: { 'Retry-After': '3600' } },
          );
        }
        failures = 0;
      }
      return startGeneration(
        {
          ...r,
          generation: { ...r.generation, failures },
          resumeRef: prepared.ref,
          resumeTextForAi: prepared.text,
          resumeInjectionSuspected: prepared.injectionSuspected,
          resumeContext: null,
          questionPlan: null,
          preparedAt: null,
        },
        'preparation',
        now,
        this.generationLeaseMs(),
      );
    });
  }

  /**
   * Null when the preparation still owns the record, consent is active and the resume is
   * unchanged; otherwise the failure code.
   */
  private async preparationProblem(id: string, token: string): Promise<string | null> {
    const cur = await this.deps.store.findById(id);
    if (!cur || cur.status !== 'accepted' || cur.generation.token !== token) return 'superseded';
    if (!(await this.consentStillActive(cur))) return 'consent_missing';
    const candidate = await this.deps.identity.findUserById(cur.candidateUserId);
    const prepared = await prepareResumeForInterview(
      this.deps.resumes,
      cur.candidateUserId,
      candidate ? [candidate.displayName] : [],
    );
    return prepared.ready && sameResume(cur.resumeRef, prepared.ref) ? null : 'resume_missing';
  }

  private async runPreparation(id: string, token: string): Promise<void> {
    const rec = await this.deps.store.findById(id);
    if (!rec || rec.generation.token !== token || rec.status !== 'accepted') return;
    const proof = this.proofOf(rec);
    if (!proof || !(await this.consentStillActive(rec)))
      return this.failGeneration(id, token, 'consent_missing');
    const resumeText = rec.resumeTextForAi;
    if (!resumeText) return this.failGeneration(id, token, 'resume_missing');
    const common = {
      timeoutMs: this.deps.aiCall.timeoutMs,
      logger: this.deps.logger,
      consent: proof,
      retry: this.retryPolicy(),
      ...this.sleepOpt(),
    };
    const ctxRes = await invokeCapability(
      this.deps.ai,
      'resume_context',
      {
        contractVersion: INTERVIEW_CONTRACT_VERSION,
        roleKey: ROLE_KEY,
        language: 'en',
        resumeText,
        truncated: false,
      },
      { ...common, outputSchema: resumeContextSchema },
    );
    if (!ctxRes.ok) return this.failGeneration(id, token, ctxRes.error.code);
    // Consent withdrawn, interview cancelled or resume replaced/deleted meanwhile: stop before
    // sending anything else to the provider.
    const problem = await this.preparationProblem(id, token);
    if (problem) return this.failGeneration(id, token, problem);
    const resumeContext = filterResumeContext(ctxRes.value, resumeText);
    const input = {
      contractVersion: INTERVIEW_CONTRACT_VERSION,
      roleKey: ROLE_KEY,
      language: 'en' as const,
      role: {
        requiredSkills: rec.briefFull.requiredSkills.map((s) => ({
          skillId: s.skillId,
          level: s.level,
          importance: s.importance,
        })),
      },
      candidate: { skills: rec.profileSnapshot?.skills ?? [], resumeContext },
      slots: questionPlanSlots(),
    };
    const planRes = await invokeCapability(this.deps.ai, 'question_plan', input, {
      ...common,
      outputSchema: questionPlanOutputSchema,
      validate: (v) => checkQuestionPlan(v, input, resumeText),
    });
    if (!planRes.ok) return this.failGeneration(id, token, planRes.error.code);
    const late = await this.preparationProblem(id, token);
    if (late) return this.failGeneration(id, token, late);
    const generatedBy = {
      provider: planRes.meta.providerId,
      model: planRes.meta.model,
      promptVersion: planRes.meta.promptVersion,
    };
    const questionPlan: PlannedQuestionRecord[] = planRes.value.questions.map((q) => ({
      ...q,
      generatedBy,
    }));
    await this.commitIfToken(id, token, (r, at) => ({
      ...r,
      resumeContext,
      questionPlan,
      preparedAt: at,
      generation: { ...IDLE_GENERATION },
    }));
  }

  async decline(user: UserRecord, id: string, reason: string): Promise<InterviewSessionView> {
    await this.asCandidate(user, id);
    const rec = await this.mutate(id, (r, now) => {
      if (r.status === 'declined') return null;
      if (r.status !== 'invited') throw invalid('Only an open invitation can be declined.');
      return { ...r, status: 'declined', declinedAt: now, declineReason: reason || null };
    });
    return this.view(user, rec, 'candidate', null);
  }

  async cancel(user: UserRecord, id: string, note: string): Promise<InterviewSessionView> {
    const { role } = await this.access(user, id);
    const reason: CancellationReason =
      role === 'founder' ? 'founder_cancelled' : 'candidate_cancelled';
    const rec = await this.mutate(id, (r, now) => {
      if (r.status === 'cancelled') return null;
      if (!['invited', 'accepted', 'in_progress', 'coding'].includes(r.status)) {
        throw invalid('This interview can no longer be cancelled.');
      }
      if (role === 'candidate' && r.status === 'invited')
        throw invalid('Decline the invitation instead.');
      return this.cancelled(r, reason, note, now);
    });
    return this.view(user, rec, role, null);
  }

  private cancelled(
    r: InterviewRecord,
    reason: CancellationReason,
    note: string | null,
    now: Date,
  ): InterviewRecord {
    return {
      ...r,
      status: 'cancelled',
      cancelledAt: now,
      cancellationReason: reason,
      cancellationNote: note || null,
      activeClientId: null,
      generation: { ...IDLE_GENERATION },
    };
  }

  /** v3.0: closing a brief cancels its invited/accepted/in-progress interviews. */
  async onBriefClosed(briefId: string): Promise<number> {
    const open = await this.deps.store.findPreSubmitForBrief(briefId);
    let n = 0;
    for (const r of open) {
      await this.mutate(r.id, (cur, now) =>
        ['invited', 'accepted', 'in_progress', 'coding'].includes(cur.status)
          ? this.cancelled(cur, 'brief_closed', null, now)
          : null,
      );
      n += 1;
    }
    return n;
  }

  /**
   * Withdraw assessment consent. Before submission the interview is cancelled; afterwards the
   * founder immediately loses access to answers and report, pending AI jobs are cancelled, and
   * the candidate keeps their own access until retention removes it.
   */
  async withdrawConsent(user: UserRecord, id: string): Promise<InterviewSessionView> {
    await this.asCandidate(user, id);
    const rec = await this.mutate(id, (r, now) => {
      if (!r.consent || r.consent.withdrawnAt) return null;
      const consent = { ...r.consent, withdrawnAt: now.toISOString() };
      if (['accepted', 'in_progress', 'coding'].includes(r.status)) {
        return { ...this.cancelled(r, 'consent_withdrawn', null, now), consent };
      }
      // After submission, an unfinished evaluation stops for good: it must not look "in
      // progress" forever (the worker cancels the job; retries require active consent).
      const stopped =
        r.status === 'submitted' && r.evaluationStatus !== 'succeeded'
          ? { evaluationStatus: 'failed' as const }
          : {};
      return { ...r, consent, generation: { ...IDLE_GENERATION }, ...stopped };
    });
    await this.deps.profiles.withdrawConsent(
      { userId: user.id, purpose: 'assessment', targetId: rec.id },
      this.now(),
    );
    await this.deps.jobs.cancel(rec.id, this.now());
    return this.view(user, rec, 'candidate', null);
  }

  // --- Phase 7: start, reconnect ----------------------------------------------------------------

  async start(user: UserRecord, id: string, clientId: string): Promise<InterviewSessionView> {
    const pre = await this.asCandidate(user, id);
    if (LIVE_STATUSES.has(pre.status)) return this.attach(user, id, clientId);
    if (pre.status !== 'accepted') throw invalid('Accept the invitation before starting.');
    await this.assertNotBlocked(pre);
    const brief = await this.deps.briefStore.findById(pre.briefId);
    if (!brief || brief.status !== 'open')
      throw invalid('The brief has closed; this interview cannot start.');
    if (!this.deps.ai.allEnabled()) {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'The AI interviewer is not configured on this server, so the interview cannot start.',
      );
    }
    if (!(await this.consentStillActive(pre)))
      throw invalid('Interview consent is no longer active.');
    const prepared = await prepareResumeForInterview(this.deps.resumes, user.id, [
      user.displayName,
    ]);
    if (!prepared.ready) {
      const r = readinessOf(prepared);
      throw new AppError('RESUME_REQUIRED', r.ready ? 'Resume required.' : r.message);
    }
    const rec = await this.mutate(id, (r, now) => {
      if (LIVE_STATUSES.has(r.status))
        return { ...r, activeClientId: clientId, lastHeartbeatAt: now };
      if (r.status !== 'accepted') throw invalid('Accept the invitation before starting.');
      if (preparationOf(r, prepared).status !== 'ready') {
        throw new AppError(
          'PREPARATION_REQUIRED',
          'Your interview questions are not ready yet. Wait until they are prepared from your resume.',
        );
      }
      const intro: TurnRecord = {
        index: 0,
        kind: 'intro',
        questionType: null,
        topic: null,
        intent: null,
        difficulty: null,
        prompt: INTERVIEW_INTRO_TEXT,
        parentIndex: null,
        resumeEvidence: null,
        targetSkills: [],
        expectedConcepts: [],
        askedAt: now.toISOString(),
        steeringSignal: null,
        generatedBy: null,
        draft: null,
        answer: null,
      };
      return startGeneration(
        {
          ...r,
          status: 'in_progress',
          startedAt: now,
          conversationDeadline: new Date(now.getTime() + L.conversationSeconds * 1000),
          globalDeadline: new Date(now.getTime() + L.globalSeconds * 1000),
          generation: { ...IDLE_GENERATION },
          turns: [intro],
          activeClientId: clientId,
          lastHeartbeatAt: now,
        },
        'question',
        now,
        this.generationLeaseMs(),
      );
    });
    return this.view(user, rec, 'candidate', clientId);
  }

  /** Reconnect or take over from another window: the newest client becomes the active one. */
  async attach(user: UserRecord, id: string, clientId: string): Promise<InterviewSessionView> {
    await this.asCandidate(user, id);
    const rec = await this.mutate(id, (r, now) => {
      if (!LIVE_STATUSES.has(r.status)) throw invalid('This interview is not in progress.');
      return { ...r, activeClientId: clientId, lastHeartbeatAt: now };
    });
    return this.view(user, rec, 'candidate', clientId);
  }

  async heartbeat(
    user: UserRecord,
    id: string,
    clientId: string,
  ): Promise<{ serverNow: string; activeElsewhere: boolean }> {
    const rec = await this.asCandidate(user, id);
    if (!LIVE_STATUSES.has(rec.status) || rec.activeClientId !== clientId) {
      return {
        serverNow: this.now().toISOString(),
        activeElsewhere: LIVE_STATUSES.has(rec.status),
      };
    }
    await this.mutate(id, (r, now) =>
      r.activeClientId === clientId ? { ...r, lastHeartbeatAt: now } : null,
    );
    return { serverNow: this.now().toISOString(), activeElsewhere: false };
  }

  /** Retry preparing the next question after a failure (or an interrupted generation). */
  async retryGeneration(
    user: UserRecord,
    id: string,
    clientId: string | null,
  ): Promise<InterviewSessionView> {
    await this.liveCandidate(user, id);
    const rec = await this.mutate(id, (r, now) => {
      this.requireLiveClient(r, clientId);
      if (r.status !== 'in_progress') return null;
      if (r.generation.status === 'running') return null;
      const last = r.turns[r.turns.length - 1];
      if (last && last.kind === 'question' && !last.answer) return null; // a question is open
      return startGeneration(r, 'question', now, this.generationLeaseMs());
    });
    return this.view(user, rec, 'candidate', clientId);
  }

  // --- Phase 8: conversation --------------------------------------------------------------------

  private redactAnswer(names: string[]) {
    return (text: string) => redactForAi(text, { knownNames: names }).text;
  }

  private async runQuestionGeneration(id: string, token: string): Promise<void> {
    let rec = await this.deps.store.findById(id);
    if (!rec || rec.generation.token !== token || rec.status !== 'in_progress') return;
    const proof = this.proofOf(rec);
    if (!proof || !(await this.consentStillActive(rec)))
      return this.failGeneration(id, token, 'consent_missing');
    const candidate = (await this.deps.identity.findUserById(rec.candidateUserId)) ?? null;
    const names = candidate ? [candidate.displayName] : [];
    const common = {
      timeoutMs: this.deps.aiCall.timeoutMs,
      logger: this.deps.logger,
      consent: proof,
      retry: this.retryPolicy(),
      ...this.sleepOpt(),
    };
    const resumeText = rec.resumeTextForAi ?? '';
    if (!rec.resumeContext) {
      const res = await invokeCapability(
        this.deps.ai,
        'resume_context',
        {
          contractVersion: INTERVIEW_CONTRACT_VERSION,
          roleKey: ROLE_KEY,
          language: 'en',
          resumeText,
          truncated: false,
        },
        { ...common, outputSchema: resumeContextSchema },
      );
      if (!res.ok) return this.failGeneration(id, token, res.error.code);
      const context = filterResumeContext(res.value, resumeText);
      const saved = await this.commitIfToken(id, token, (r) => ({ ...r, resumeContext: context }));
      if (!saved) return;
      rec = saved;
    }
    const now = this.now();
    const clock = { now, conversationDeadline: rec.conversationDeadline! };
    if (conversationMustEnd(rec.turns, clock)) {
      await this.commitIfToken(id, token, (r, at) => this.enterCoding(r, at));
      return;
    }
    const lastAnswered = [...questionTurns(rec.turns)].reverse().find((t) => t.answer) ?? null;
    const policy = computeTurnPolicy(rec.turns, clock);
    // The prepared question for the next topic (absent on interviews prepared before plans).
    const candidatePlanned = rec.questionPlan?.[openedTopics(rec.turns)] ?? null;
    // Used only if it still fits: expected type, topic not covered, not a repeat of anything
    // already asked (otherwise the live interviewer writes the next topic question).
    const planned =
      candidatePlanned &&
      candidatePlanned.type === policy.newTopicType &&
      !policy.coveredTopics.some(
        (t) => normalizeForQuote(t) === normalizeForQuote(candidatePlanned.topic),
      ) &&
      !rec.turns.some(
        (t) => promptSimilarity(t.prompt, candidatePlanned.prompt) >= REPEAT_SIMILARITY_THRESHOLD,
      )
        ? candidatePlanned
        : null;
    // A new topic is required (first question, after a skip, or follow-ups exhausted): ask the
    // prepared question straight away — no model call between answer and question.
    if (planned && policy.mustChangeTopic) {
      await this.commitIfToken(id, token, (r, at) => this.askPlanned(r, planned, at, null));
      return;
    }
    const input: InterviewTurnInput = {
      contractVersion: INTERVIEW_CONTRACT_VERSION,
      roleKey: ROLE_KEY,
      language: 'en',
      role: {
        requiredSkills: rec.briefFull.requiredSkills.map((s) => ({
          skillId: s.skillId,
          level: s.level,
          importance: s.importance,
        })),
      },
      candidate: {
        skills: rec.profileSnapshot?.skills ?? [],
        resumeContext: rec.resumeContext!,
      },
      history: historyForPrompt(rec.turns, this.redactAnswer(names)),
      lastAnswerIndex: lastAnswered?.index ?? null,
      policy,
      plannedNext: planned
        ? { type: planned.type, topic: planned.topic, prompt: planned.prompt }
        : null,
    };
    // When a prepared question exists, a new-topic output is replaced by it, so only the
    // follow-up / end parts of the output need to pass the policy check.
    const opensPlanned = (v: InterviewTurnOutput) =>
      planned !== null && v.decision === 'ask' && v.question?.followsUp === null;
    const res = await invokeCapability(this.deps.ai, 'interview_turn', input, {
      ...common,
      outputSchema: interviewTurnOutputSchema,
      validate: (v) => (opensPlanned(v) ? null : checkTurnPolicy(v, input, resumeText)),
    });
    if (!res.ok) return this.failGeneration(id, token, res.error.code);
    if (!(await this.consentStillActive(rec)))
      return this.failGeneration(id, token, 'consent_missing');
    const out = res.value;
    if (out.decision === 'end' || !out.question) {
      await this.commitIfToken(id, token, (r, at) => this.enterCoding(r, at));
      return;
    }
    if (planned && out.question.followsUp === null) {
      const signal = lastAnswered ? out.assessment.signal : null;
      await this.commitIfToken(id, token, (r, at) =>
        this.askPlanned(
          r,
          planned,
          at,
          lastAnswered ? { index: lastAnswered.index, signal } : null,
        ),
      );
      return;
    }
    const q = out.question;
    await this.commitIfToken(id, token, (r, at) => {
      const turns = r.turns.map((t) =>
        lastAnswered && t.index === lastAnswered.index
          ? { ...t, steeringSignal: out.assessment.signal }
          : t,
      );
      turns.push({
        index: turns.length,
        kind: 'question',
        questionType: q.type,
        topic: q.topic,
        intent: q.intent,
        difficulty: q.difficulty,
        prompt: q.prompt,
        parentIndex: q.followsUp,
        resumeEvidence: q.resumeEvidence,
        targetSkills: q.targetSkills,
        expectedConcepts: q.expectedConcepts,
        askedAt: at.toISOString(),
        steeringSignal: null,
        generatedBy: {
          provider: res.meta.providerId,
          model: res.meta.model,
          promptVersion: res.meta.promptVersion,
        },
        draft: null,
        answer: null,
      });
      return { ...r, turns, generation: { ...IDLE_GENERATION } };
    });
  }

  /** Appends a prepared topic question as the next turn. */
  private askPlanned(
    r: InterviewRecord,
    planned: PlannedQuestionRecord,
    at: Date,
    steering: { index: number; signal: TurnRecord['steeringSignal'] } | null,
  ): InterviewRecord {
    const turns = r.turns.map((t) =>
      steering && t.index === steering.index ? { ...t, steeringSignal: steering.signal } : t,
    );
    turns.push({
      index: turns.length,
      kind: 'question',
      questionType: planned.type,
      topic: planned.topic,
      intent: 'new_topic',
      difficulty: planned.difficulty,
      prompt: planned.prompt,
      parentIndex: null,
      resumeEvidence: planned.resumeEvidence,
      targetSkills: planned.targetSkills,
      expectedConcepts: planned.expectedConcepts,
      askedAt: at.toISOString(),
      steeringSignal: null,
      generatedBy: { ...planned.generatedBy },
      draft: null,
      answer: null,
    });
    return { ...r, turns, generation: { ...IDLE_GENERATION } };
  }

  private enterCoding(r: InterviewRecord, now: Date): InterviewRecord {
    const turns = skipOpenQuestion(r.turns, 'manual_skip', now);
    return startGeneration(
      { ...r, turns, status: 'coding', coding: null, codingDeadline: null },
      'coding_setup',
      now,
      this.generationLeaseMs(),
    );
  }

  private async failGeneration(id: string, token: string, code: string): Promise<void> {
    await this.commitIfToken(id, token, (r) => ({
      ...r,
      generation: {
        ...r.generation,
        status: 'failed',
        token: null,
        leaseUntil: null,
        failures: r.generation.failures + 1,
        lastErrorCode: code,
        failedAt: this.now().toISOString(),
      },
    }));
  }

  private async commitIfToken(
    id: string,
    token: string,
    fn: (r: InterviewRecord, now: Date) => InterviewRecord,
  ): Promise<InterviewRecord | null> {
    let applied = false;
    try {
      const saved = await this.mutate(id, (r, now) => {
        applied = false;
        if (r.generation.token !== token || r.generation.status !== 'running') return null;
        applied = true;
        return fn(r, now);
      });
      return applied ? saved : null;
    } catch (err) {
      if (err instanceof AppError) return null;
      throw err;
    }
  }

  private async runCodingSetup(id: string, token: string): Promise<void> {
    const rec = await this.deps.store.findById(id);
    if (!rec || rec.generation.token !== token || rec.status !== 'coding') return;
    const proof = this.proofOf(rec);
    const roleSkills = rec.briefFull.requiredSkills.map((s) => s.skillId);
    let coding: CodingRecord | null = null;
    if (proof && (await this.consentStillActive(rec))) {
      const input = {
        contractVersion: INTERVIEW_CONTRACT_VERSION,
        roleKey: ROLE_KEY,
        language: 'en' as const,
        roleSkills,
        candidateSkills: rec.profileSnapshot?.skills ?? [],
        conversation: questionTurns(rec.turns)
          .filter((t) => t.questionType && t.topic)
          .map((t) => ({
            questionType: t.questionType!,
            topic: t.topic!,
            signal: t.steeringSignal ?? 'not_applicable',
          })),
        tasks: CODING_TASKS.map((t) => ({
          id: t.id,
          title: t.title,
          kind: t.kind,
          skills: t.skills,
          difficulty: t.difficulty,
        })),
      };
      const res = await invokeCapability(this.deps.ai, 'coding_task_selection', input, {
        timeoutMs: Math.min(10_000, this.deps.aiCall.timeoutMs),
        logger: this.deps.logger,
        consent: proof,
        outputSchema: codingTaskSelectionSchema,
        validate: (v) => checkTaskSelection(v, input),
      });
      if (res.ok) {
        const task = findTask(res.value.taskId)!;
        coding = codingRecordFor(rec, task.id, task.version, this.now(), {
          method: 'ai',
          reason: res.value.reason,
          provider: res.meta.providerId,
          model: res.meta.model,
        });
      }
    }
    await this.commitIfToken(id, token, (r, now) => {
      const c = coding ? { ...coding, startedAt: now.toISOString() } : ruleBasedCoding(r, now);
      return {
        ...r,
        coding: c,
        codingDeadline: new Date(c.deadline),
        generation: { ...IDLE_GENERATION },
      };
    });
  }

  private openQuestion(r: InterviewRecord, turnIndex: number): TurnRecord {
    if (r.status !== 'in_progress')
      throw new AppError('QUESTION_CLOSED', 'The conversation stage has ended.');
    const turn = r.turns.find((t) => t.index === turnIndex);
    const last = r.turns[r.turns.length - 1];
    if (!turn || turn.kind !== 'question' || turn !== last || turn.answer) {
      throw new AppError(
        'QUESTION_CLOSED',
        'This question is closed. Reload to see the current question.',
      );
    }
    return turn;
  }

  async transcribe(
    user: UserRecord,
    id: string,
    turnIndex: number,
    clientId: string | null,
    audio: Buffer,
    contentType: string,
  ): Promise<InterviewSessionView> {
    const pre = await this.liveCandidate(user, id);
    this.requireLiveClient(pre, clientId);
    this.openQuestion(pre, turnIndex);
    if (!pre.consent?.items.speech_transcription) {
      throw invalid('Voice answers were not enabled for this interview; type your answer instead.');
    }
    if (!isSupportedAudioType(contentType)) {
      throw new AppError('VALIDATION_FAILED', 'Unsupported audio format.', {
        fieldErrors: { audio: ['Unsupported audio format.'] },
      });
    }
    if (audio.length === 0) {
      throw new AppError('VALIDATION_FAILED', 'The recording was empty.', {
        fieldErrors: { audio: ['The recording was empty.'] },
      });
    }
    const used = pre.turns.find((t) => t.index === turnIndex)?.draft?.recordingsUsed ?? 0;
    if (used >= L.maxRecordingsPerTurn) {
      throw invalid(
        `You can record at most ${L.maxRecordingsPerTurn} times per question. Edit or type the transcript instead.`,
      );
    }
    let raw;
    try {
      raw = await this.deps.speech.stt.transcribe(
        audio,
        baseContentType(contentType),
        AbortSignal.timeout(120_000),
      );
    } catch (err) {
      const code = err instanceof SpeechError ? err.code : 'unavailable';
      this.deps.logger.warn({ code }, 'transcription failed');
      throw new AppError(
        code === 'rejected' ? 'VALIDATION_FAILED' : 'SERVICE_UNAVAILABLE',
        code === 'rejected'
          ? 'This recording could not be processed. Record again or type your answer.'
          : 'Transcription is unavailable right now. Try again or type your answer.',
      );
    }
    if (raw.durationSec > L.audioMaxSeconds + 5) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Answers can be at most ${L.audioMaxSeconds / 60} minutes long.`,
      );
    }
    const analysed = analyseTranscript(raw);
    const rec = await this.mutate(id, (r, now) => {
      this.requireLiveClient(r, clientId);
      const turn = this.openQuestion(r, turnIndex);
      const recordingsUsed = (turn.draft?.recordingsUsed ?? 0) + 1;
      if (recordingsUsed > L.maxRecordingsPerTurn)
        throw invalid('Recording limit reached for this question.');
      return {
        ...r,
        turns: r.turns.map((t) =>
          t.index === turnIndex
            ? {
                ...t,
                draft: {
                  text: Array.from(analysed.text).slice(0, L.answerMaxChars).join(''),
                  original: Array.from(analysed.text).slice(0, L.answerMaxChars).join(''),
                  segments: analysed.segments,
                  confidence: analysed.confidence,
                  noSpeech: analysed.noSpeech,
                  durationSec: analysed.durationSec,
                  uncertainSegments: analysed.uncertainSegments,
                  recordingsUsed,
                  model: raw.model,
                  createdAt: now.toISOString(),
                },
              }
            : t,
        ),
      };
    });
    return this.view(user, rec, 'candidate', clientId);
  }

  async submitAnswer(
    user: UserRecord,
    id: string,
    turnIndex: number,
    clientId: string | null,
    body: AnswerSubmitRequest,
  ): Promise<InterviewSessionView> {
    await this.liveCandidate(user, id);
    const rec = await this.mutate(id, (r, now) => {
      this.requireLiveClient(r, clientId);
      const turn = this.openQuestion(r, turnIndex);
      let answer: TurnRecord['answer'];
      if (body.skip) {
        answer = {
          text: '',
          inputMode: body.inputMode,
          transcriptOriginal: turn.draft?.original ?? null,
          transcriptConfidence: turn.draft?.confidence ?? null,
          uncertainSegments: 0,
          edited: false,
          editRatio: null,
          skipped: true,
          skipReason: 'manual_skip',
          submittedAt: now.toISOString(),
          injectionSuspected: false,
        };
      } else {
        const text = body.text.trim();
        if (text.length === 0) {
          throw new AppError('VALIDATION_FAILED', 'Answer the question or choose Skip.', {
            fieldErrors: { text: ['Required.'] },
          });
        }
        if (body.inputMode === 'voice' && !turn.draft) {
          throw new AppError(
            'VALIDATION_FAILED',
            'Record your answer first, or switch to typing.',
            { fieldErrors: { inputMode: ['No recording.'] } },
          );
        }
        const voice = body.inputMode === 'voice' && turn.draft;
        const ratio = voice ? editRatio(turn.draft!.text, text) : null;
        answer = {
          text,
          inputMode: body.inputMode,
          transcriptOriginal: voice ? turn.draft!.original : null,
          transcriptConfidence: voice ? turn.draft!.confidence : null,
          uncertainSegments: voice ? turn.draft!.uncertainSegments : 0,
          edited: voice ? text !== turn.draft!.text : false,
          editRatio: ratio,
          skipped: false,
          skipReason: null,
          submittedAt: now.toISOString(),
          injectionSuspected: looksLikePromptInjection(text),
        };
      }
      const turns = r.turns.map((t) => (t.index === turnIndex ? { ...t, draft: null, answer } : t));
      return startGeneration({ ...r, turns }, 'question', now, this.generationLeaseMs());
    });
    return this.view(user, rec, 'candidate', clientId);
  }

  async finishConversation(
    user: UserRecord,
    id: string,
    clientId: string | null,
  ): Promise<InterviewSessionView> {
    await this.liveCandidate(user, id);
    const rec = await this.mutate(id, (r, now) => {
      this.requireLiveClient(r, clientId);
      if (r.status === 'coding') return null;
      if (r.status !== 'in_progress') throw invalid('The conversation is not in progress.');
      // Same rule as the offered action: finishing early needs at least one real answer.
      if (answeredCount(r.turns) === 0)
        throw invalid('Answer at least one question before finishing the conversation.');
      return this.enterCoding(r, now);
    });
    return this.view(user, rec, 'candidate', clientId);
  }

  /** Text-to-speech of a question the candidate has been asked (or the voice check). */
  async speech(user: UserRecord, id: string, turnIndex: number | 'voice-test'): Promise<Buffer> {
    const rec = await this.asCandidate(user, id);
    let text: string;
    if (turnIndex === 'voice-test') {
      if (!['accepted', 'in_progress', 'coding'].includes(rec.status))
        throw invalid('Voice check is available after accepting.');
      text = VOICE_TEST_TEXT;
    } else {
      if (!LIVE_STATUSES.has(rec.status)) throw invalid('The interview is not in progress.');
      const turn = rec.turns.find((t) => t.index === turnIndex);
      if (!turn) throw notFound();
      text = turn.prompt;
    }
    if (!this.deps.speech.tts.configured) {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'Spoken questions are not available; read the question on screen.',
      );
    }
    const key = text;
    const cached = this.ttsCache.get(key);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.wav;
    try {
      const wav = await this.deps.speech.tts.synthesize(text, AbortSignal.timeout(30_000));
      this.ttsCache.set(key, { at: Date.now(), wav });
      if (this.ttsCache.size > 100) this.ttsCache.delete(this.ttsCache.keys().next().value!);
      return wav;
    } catch {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'Spoken questions are not available right now; read the question on screen.',
      );
    }
  }

  // --- Phase 9: coding round --------------------------------------------------------------------

  private codingOpen(r: InterviewRecord): CodingRecord {
    if (r.status !== 'coding' || !r.coding) throw invalid('The coding task is not open.');
    if (r.coding.submission) throw invalid('The solution was already submitted.');
    return r.coding;
  }

  async saveCode(
    user: UserRecord,
    id: string,
    clientId: string | null,
    language: CodeLanguage,
    code: string,
    explanation?: string,
  ): Promise<InterviewSessionView> {
    await this.liveCandidate(user, id);
    const rec = await this.mutate(id, (r, now) => {
      this.requireLiveClient(r, clientId);
      const c = this.codingOpen(r);
      const draft = {
        language,
        code,
        explanation: explanation ?? c.draft?.explanation ?? '',
        savedAt: now.toISOString(),
      };
      return { ...r, coding: { ...c, draft } };
    });
    return this.view(user, rec, 'candidate', clientId);
  }

  async runCode(
    user: UserRecord,
    id: string,
    clientId: string | null,
    language: CodeLanguage,
    code: string,
  ): Promise<InterviewSessionView> {
    await this.liveCandidate(user, id);
    if (!this.deps.judge.available) {
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        this.deps.judge.unavailableReason ?? 'Code execution is unavailable.',
      );
    }
    // Reserve the run first so parallel requests cannot exceed the per-session budget.
    const reserved = await this.mutate(id, (r, now) => {
      this.requireLiveClient(r, clientId);
      const c = this.codingOpen(r);
      if (c.runCount >= L.codeRunsPerSession)
        throw invalid('You have used every test run for this task.');
      return {
        ...r,
        coding: {
          ...c,
          runCount: c.runCount + 1,
          draft: {
            language,
            code,
            explanation: c.draft?.explanation ?? '',
            savedAt: now.toISOString(),
          },
        },
      };
    });
    const task = findTask(reserved.coding!.taskId)!;
    let graded;
    try {
      graded = await runVisibleTests(
        this.deps.judge,
        task,
        language,
        code,
        AbortSignal.timeout(60_000),
      );
    } catch (err) {
      if (err instanceof JudgeUnavailableError) graded = null;
      else throw err;
    }
    if (!graded || graded.status === 'internal_error') {
      // A sandbox fault is not the candidate's run: give the reserved run back.
      await this.mutate(id, (r) =>
        r.status === 'coding' && r.coding && r.coding.runCount > 0
          ? { ...r, coding: { ...r.coding, runCount: r.coding.runCount - 1 } }
          : null,
      );
      throw new AppError(
        'SERVICE_UNAVAILABLE',
        'The code execution sandbox failed to run your code. This did not use up a run; try again shortly.',
      );
    }
    const rec = await this.mutate(id, (r, now) => {
      if (r.status !== 'coding' || !r.coding) return null;
      const run = {
        at: now.toISOString(),
        language,
        status: graded.status,
        results: graded.tests.map((t) => ({
          name: t.name,
          outcome: t.outcome,
          expected: t.expected,
          actual: t.actual,
          message: t.message,
        })),
        passed: graded.tests.filter((t) => t.outcome === 'passed').length,
        total: graded.tests.length,
        diagnostics: graded.diagnostics,
      };
      return { ...r, coding: { ...r.coding, runs: [...r.coding.runs, run].slice(-10) } };
    });
    return this.view(user, rec, 'candidate', clientId);
  }

  async submitCode(
    user: UserRecord,
    id: string,
    clientId: string | null,
    body: { language: CodeLanguage; code: string; explanation: string },
  ): Promise<InterviewSessionView> {
    await this.liveCandidate(user, id);
    const rec = await this.mutate(id, (r, now) => {
      if (r.status === 'submitted') {
        // A repeated manual submission is a harmless replay; after the deadline the autosaved
        // draft was submitted instead, and the candidate must be told this code was not used.
        if (r.coding?.submission?.autoSubmitted) {
          throw invalid(
            'Time ran out before this submission arrived, so your last autosaved code was submitted instead.',
          );
        }
        return null;
      }
      this.requireLiveClient(r, clientId);
      const c = this.codingOpen(r);
      const coding: CodingRecord = {
        ...c,
        draft: {
          language: body.language,
          code: body.code,
          explanation: body.explanation,
          savedAt: now.toISOString(),
        },
        submission: {
          language: body.language,
          code: body.code,
          explanation: body.explanation,
          submittedAt: now.toISOString(),
          autoSubmitted: false,
        },
      };
      return submitted({ ...r, coding, activeClientId: null }, now);
    });
    return this.view(user, rec, 'candidate', clientId);
  }

  // --- Sweeper ----------------------------------------------------------------------------------

  /** 15-second job: deadlines, expiry, interrupted generation, missing evaluation jobs. */
  async sweep(): Promise<number> {
    const ids = await this.deps.store.findIdsNeedingReconcile(this.now(), 100);
    for (const id of ids) {
      const rec = await this.deps.store.findById(id);
      if (!rec) continue;
      const after = await this.reconciled(rec);
      if (after.status === 'submitted' && after.evaluationStatus === 'queued') {
        const job = await this.deps.jobs.findBySession(after.id);
        if (!job) await this.enqueueEvaluation(after);
      }
    }
    // A crash (or a failed insert) between committing the submission and enqueueing its job
    // would otherwise leave "evaluation in progress" forever.
    const waiting = await this.deps.store.findAwaitingEvaluation(
      new Date(this.now().getTime() - 60_000),
      100,
    );
    for (const id of waiting) {
      if (await this.deps.jobs.findBySession(id)) continue;
      const rec = await this.deps.store.findById(id);
      if (rec && rec.status === 'submitted' && rec.evaluationStatus === 'queued')
        await this.enqueueEvaluation(rec);
    }
    return ids.length + waiting.length;
  }

  /**
   * Retention (contract Section 24 defaults): declined/expired/cancelled invitations keep minimal
   * status only after 30 days; everything is deleted 18 months after invitation.
   */
  async purgeRetention(): Promise<{ minimized: number; deleted: number }> {
    const now = this.now();
    const held = (await this.safety?.heldSessionIds()) ?? new Set<string>();
    const ids = (
      await this.deps.store.findTerminalToMinimize(
        new Date(now.getTime() - 30 * 24 * 3600_000),
        200,
      )
    ).filter((id) => !held.has(id));
    for (const id of ids) {
      await this.mutate(id, (r, at) =>
        r.minimizedAt
          ? null
          : {
              ...r,
              turns: [],
              coding: null,
              profileSnapshot: null,
              resumeTextForAi: null,
              resumeContext: null,
              questionPlan: null,
              declineReason: null,
              cancellationNote: null,
              minimizedAt: at,
            },
      ).catch(() => undefined);
    }
    const deleted = await this.deps.store.deleteInvitedBefore(
      new Date(now.getTime() - 548 * 24 * 3600_000),
      held,
    );
    for (const id of deleted) {
      await this.deps.jobs.deleteForSession(id);
      await this.deps.reports.deleteForSession(id);
    }
    return { minimized: ids.length, deleted: deleted.length };
  }

  // Exposed for the report service.
  async participantRecord(user: UserRecord, id: string) {
    return this.access(user, id);
  }

  async markEvaluation(
    id: string,
    status: InterviewRecord['evaluationStatus'],
    reportId?: string,
  ): Promise<void> {
    await this.mutate(id, (r) =>
      r.evaluationStatus === status && (reportId === undefined || r.reportId === reportId)
        ? null
        : { ...r, evaluationStatus: status, ...(reportId !== undefined ? { reportId } : {}) },
    );
  }

  async useManualRetry(user: UserRecord, id: string): Promise<InterviewRecord> {
    const { role } = await this.access(user, id);
    const current = await this.load(id);
    if (!consentActive(current)) {
      if (role === 'founder') throw notFound();
      throw invalid('Assessment consent was withdrawn, so this evaluation cannot be retried.');
    }
    return this.mutate(id, (r) => {
      if (!consentActive(r))
        throw invalid('Assessment consent was withdrawn, so this evaluation cannot be retried.');
      if (r.status !== 'submitted' || r.evaluationStatus !== 'failed')
        throw invalid('Evaluation can be retried only after it failed.');
      if (r.manualRetriesUsed >= L.manualEvaluationRetries)
        throw invalid('The retry budget for this evaluation is used up.');
      return { ...r, manualRetriesUsed: r.manualRetriesUsed + 1, evaluationStatus: 'queued' };
    });
  }

  /** GET /interviews/:id/report — both participants; founder only while consent is active. */
  async report(user: UserRecord, id: string): Promise<ReportResponse> {
    const { rec, role } = await this.access(user, id);
    if (rec.status !== 'submitted')
      throw invalid('The report is available after the interview is submitted.');
    if (role === 'founder' && !consentActive(rec)) {
      throw new AppError(
        'FORBIDDEN',
        'The candidate withdrew assessment consent; this report is no longer available to you.',
      );
    }
    if (
      role === 'founder' &&
      (rec.blockedAt || (await this.safety?.isBlocked(rec.founderUserId, rec.candidateUserId)))
    ) {
      throw new AppError('FORBIDDEN', 'This collaboration is no longer available.');
    }
    const retryAllowed = await this.retryAllowed(rec);
    const stored = rec.reportId ? await this.deps.reports.findLatest(rec.id) : null;
    if (stored && rec.evaluationStatus === 'succeeded') {
      if (role === 'founder') await this.safety?.auditReportRead(user.id, rec.id);
      const overlays = (await this.safety?.reportOverlays(rec.id)) ?? {
        corrections: [],
        openCorrections: 0,
      };
      const data = stored.data as StoredReport;
      return {
        state: 'ready',
        report: {
          ...(rec.reportQuarantinedAt ? withoutNarrative(data) : data),
          evaluationStatus: rec.evaluationStatus,
          retryAllowed,
          corrections: overlays.corrections,
          openCorrections: overlays.openCorrections,
          quarantine: rec.reportQuarantinedAt
            ? { at: rec.reportQuarantinedAt.toISOString(), notice: QUARANTINE_NOTICE }
            : null,
        },
      };
    }
    const message = !consentActive(rec)
      ? 'The evaluation was stopped because assessment consent was withdrawn.'
      : rec.evaluationStatus === 'failed'
        ? 'The evaluation could not be completed because an AI or execution service failed. The answers are saved; retry when the service is available.'
        : 'The evaluation is in progress. This page updates automatically.';
    return {
      state: 'pending',
      pending: {
        interviewId: rec.id,
        evaluationStatus: rec.evaluationStatus,
        retryAllowed,
        message,
      },
    };
  }

  async retryEvaluation(user: UserRecord, id: string): Promise<{ evaluationStatus: 'queued' }> {
    const rec = await this.useManualRetry(user, id);
    const requeued = await this.deps.jobs.requeue(rec.id, this.now(), EVALUATION_MAX_ATTEMPTS);
    if (!requeued) await this.enqueueEvaluation(rec);
    return { evaluationStatus: 'queued' };
  }

  async partyNames(rec: InterviewRecord) {
    const p = await this.parties(rec);
    return {
      candidate: partyOf(p.candidate),
      founder: partyOf(p.founder),
      candidateUser: p.candidate,
    };
  }
}
