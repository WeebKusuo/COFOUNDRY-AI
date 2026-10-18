import type {
  EvaluationJobRecord,
  InterviewRecord,
  ReportRecord,
} from '../../src/interviews/records.js';
import {
  PRE_SUBMIT_STATUSES,
  type EvaluationJobStore,
  type InterviewStore,
  type ReportStore,
} from '../../src/interviews/store.js';

const c = <T>(v: T): T => structuredClone(v);

/** In-memory InterviewStore with the same uniqueness, ordering and rev semantics as MongoDB. */
export class MemoryInterviewStore implements InterviewStore {
  records = new Map<string, InterviewRecord>();
  /** Hook to simulate a concurrent writer before a replace (tests). */
  beforeReplace: ((id: string) => void) | null = null;

  async insert(record: InterviewRecord) {
    if (this.records.has(record.id)) return 'exists' as const;
    for (const r of this.records.values()) {
      if (r.briefId === record.briefId && r.candidateUserId === record.candidateUserId) {
        return 'duplicate_pair' as const;
      }
    }
    this.records.set(record.id, c(record));
    return 'created' as const;
  }
  async findById(id: string) {
    const r = this.records.get(id);
    return r ? c(r) : null;
  }
  async findByPair(briefId: string, candidateUserId: string) {
    const r = [...this.records.values()].find(
      (x) => x.briefId === briefId && x.candidateUserId === candidateUserId,
    );
    return r ? c(r) : null;
  }
  async countInvitedSince(founderUserId: string, since: Date) {
    return [...this.records.values()].filter(
      (r) => r.founderUserId === founderUserId && r.invitedAt >= since,
    ).length;
  }
  async list(
    filter: { founderUserId?: string; candidateUserId?: string; briefId?: string; status?: string },
    page: { after: { invitedAt: Date; id: string } | null; limit: number },
  ) {
    return [...this.records.values()]
      .filter(
        (r) =>
          (!filter.founderUserId || r.founderUserId === filter.founderUserId) &&
          (!filter.candidateUserId || r.candidateUserId === filter.candidateUserId) &&
          (!filter.briefId || r.briefId === filter.briefId) &&
          (!filter.status || r.status === filter.status),
      )
      .sort((a, b) => b.invitedAt.getTime() - a.invitedAt.getTime() || (b.id < a.id ? -1 : 1))
      .filter(
        (r) =>
          !page.after ||
          r.invitedAt < page.after.invitedAt ||
          (r.invitedAt.getTime() === page.after.invitedAt.getTime() && r.id < page.after.id),
      )
      .slice(0, page.limit + 1)
      .map(c);
  }
  async replace(next: InterviewRecord, expectedRev: number) {
    this.beforeReplace?.(next.id);
    const cur = this.records.get(next.id);
    if (!cur || cur.rev !== expectedRev) return null;
    const stored = c({ ...next, rev: expectedRev + 1 });
    this.records.set(next.id, stored);
    return c(stored);
  }
  async findIdsNeedingReconcile(now: Date, limit: number) {
    return [...this.records.values()]
      .filter(
        (r) =>
          ((r.status === 'invited' || r.status === 'accepted') && r.expiresAt <= now) ||
          (r.status === 'in_progress' &&
            r.conversationDeadline !== null &&
            r.conversationDeadline <= now) ||
          ((r.status === 'in_progress' || r.status === 'coding') &&
            r.globalDeadline !== null &&
            r.globalDeadline <= now) ||
          (r.status === 'coding' && r.codingDeadline !== null && r.codingDeadline <= now) ||
          (r.generation.status === 'running' &&
            r.generation.leaseUntil !== null &&
            r.generation.leaseUntil <= now.toISOString()) ||
          (r.status === 'submitted' && r.evaluationStatus === 'none'),
      )
      .slice(0, limit)
      .map((r) => r.id);
  }
  async findAwaitingEvaluation(submittedBefore: Date, limit: number) {
    return [...this.records.values()]
      .filter(
        (r) =>
          r.status === 'submitted' &&
          r.evaluationStatus === 'queued' &&
          r.submittedAt !== null &&
          r.submittedAt <= submittedBefore,
      )
      .sort((a, b) => a.submittedAt!.getTime() - b.submittedAt!.getTime())
      .slice(0, limit)
      .map((r) => r.id);
  }
  async findPreSubmitForBrief(briefId: string) {
    return [...this.records.values()]
      .filter((r) => r.briefId === briefId && PRE_SUBMIT_STATUSES.includes(r.status))
      .map(c);
  }
  async findTerminalToMinimize(cutoff: Date, limit: number) {
    return [...this.records.values()]
      .filter(
        (r) =>
          ['declined', 'expired', 'cancelled'].includes(r.status) &&
          r.minimizedAt === null &&
          r.updatedAt < cutoff,
      )
      .slice(0, limit)
      .map((r) => r.id);
  }
  async deleteInvitedBefore(cutoff: Date, except?: ReadonlySet<string>) {
    const ids = [...this.records.values()]
      .filter((r) => r.invitedAt < cutoff && !except?.has(r.id))
      .map((r) => r.id);
    for (const id of ids) this.records.delete(id);
    return ids;
  }
}

export class MemoryEvaluationJobStore implements EvaluationJobStore {
  jobs = new Map<string, EvaluationJobRecord>();
  async enqueue(job: EvaluationJobRecord) {
    const existing = [...this.jobs.values()].find((j) => j.sessionId === job.sessionId);
    if (existing) return c(existing);
    this.jobs.set(job.id, c(job));
    return c(job);
  }
  async findBySession(sessionId: string) {
    const j = [...this.jobs.values()].find((x) => x.sessionId === sessionId);
    return j ? c(j) : null;
  }
  async claim(now: Date, owner: string, leaseMs: number) {
    const due = [...this.jobs.values()]
      .filter(
        (j) =>
          (j.status === 'queued' && j.nextRunAt <= now) ||
          (j.status === 'running' && j.leaseUntil !== null && j.leaseUntil <= now),
      )
      .sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime())[0];
    if (!due) return null;
    due.status = 'running';
    due.leaseOwner = owner;
    due.leaseUntil = new Date(now.getTime() + leaseMs);
    due.attempts += 1;
    due.updatedAt = now;
    return c(due);
  }
  async saveSteps(
    jobId: string,
    owner: string,
    steps: EvaluationJobRecord['steps'],
    leaseUntil: Date,
  ) {
    const j = this.jobs.get(jobId);
    if (!j || j.leaseOwner !== owner || j.status !== 'running') return false;
    j.steps = c(steps);
    j.leaseUntil = leaseUntil;
    return true;
  }
  async finish(
    jobId: string,
    owner: string,
    status: 'succeeded' | 'failed',
    lastErrorCode: string | null,
    at: Date,
  ) {
    const j = this.jobs.get(jobId);
    if (!j || j.leaseOwner !== owner || j.status !== 'running') return false;
    Object.assign(j, { status, lastErrorCode, finishedAt: at, leaseOwner: null, leaseUntil: null });
    return true;
  }
  async reschedule(jobId: string, owner: string, nextRunAt: Date, lastErrorCode: string) {
    const j = this.jobs.get(jobId);
    if (!j || j.leaseOwner !== owner || j.status !== 'running') return false;
    Object.assign(j, {
      status: 'queued',
      nextRunAt,
      lastErrorCode,
      leaseOwner: null,
      leaseUntil: null,
    });
    return true;
  }
  async requeue(sessionId: string, now: Date, maxAttempts: number) {
    const j = [...this.jobs.values()].find(
      (x) => x.sessionId === sessionId && x.status === 'failed',
    );
    if (!j) return null;
    Object.assign(j, {
      status: 'queued',
      attempts: 0,
      maxAttempts,
      nextRunAt: now,
      finishedAt: null,
    });
    return c(j);
  }
  async cancel(sessionId: string, at: Date) {
    for (const j of this.jobs.values()) {
      if (j.sessionId === sessionId && ['queued', 'running', 'failed'].includes(j.status)) {
        Object.assign(j, {
          status: 'cancelled',
          leaseOwner: null,
          leaseUntil: null,
          finishedAt: at,
        });
      }
    }
  }
  async deleteForSession(sessionId: string) {
    for (const [id, j] of this.jobs) if (j.sessionId === sessionId) this.jobs.delete(id);
  }
}

export class MemoryReportStore implements ReportStore {
  reports: ReportRecord[] = [];
  async insert(report: ReportRecord) {
    const existing = this.reports.find(
      (r) => r.sessionId === report.sessionId && r.version === report.version,
    );
    if (existing) return c(existing);
    this.reports.push(c(report));
    return c(report);
  }
  async findLatest(sessionId: string) {
    const r = this.reports
      .filter((x) => x.sessionId === sessionId)
      .sort((a, b) => b.version - a.version)[0];
    return r ? c(r) : null;
  }
  async deleteForSession(sessionId: string) {
    this.reports = this.reports.filter((r) => r.sessionId !== sessionId);
  }
}
