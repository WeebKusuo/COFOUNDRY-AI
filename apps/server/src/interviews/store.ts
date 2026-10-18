import mongoose, { type Connection, type mongo } from 'mongoose';
import type { InterviewStatus } from '@cofoundry/shared';
import type {
  EvaluationJobRecord,
  EvaluationSteps,
  InterviewRecord,
  ReportRecord,
} from './records.js';

/**
 * Persistence ports for interviews (Phases 7-10). Every session mutation is ONE conditional
 * replace on `rev`, so concurrent requests (two tabs, the deadline sweeper, background
 * generation) can never overwrite each other's changes; the loser re-reads and re-decides.
 * Jobs use leases so a crashed worker's job is picked up again; step results are saved as they
 * finish, which makes retries idempotent (completed steps are not re-run).
 */

export interface InterviewListFilter {
  founderUserId?: string;
  candidateUserId?: string;
  briefId?: string;
  status?: InterviewStatus;
}

export interface InterviewPage {
  after: { invitedAt: Date; id: string } | null;
  limit: number;
}

export interface InterviewStore {
  /** 'exists' = same id already stored (idempotent retry); 'duplicate_pair' = brief/candidate taken. */
  insert(record: InterviewRecord): Promise<'created' | 'exists' | 'duplicate_pair'>;
  findById(id: string): Promise<InterviewRecord | null>;
  findByPair(briefId: string, candidateUserId: string): Promise<InterviewRecord | null>;
  countInvitedSince(founderUserId: string, since: Date): Promise<number>;
  /** Newest first; returns up to limit + 1 so callers can tell whether another page exists. */
  list(filter: InterviewListFilter, page: InterviewPage): Promise<InterviewRecord[]>;
  /** Writes `next` with rev = expectedRev + 1 only if the stored rev equals expectedRev. */
  replace(next: InterviewRecord, expectedRev: number): Promise<InterviewRecord | null>;
  /** Sessions whose deadlines, expiry, generation lease or evaluation enqueue need attention. */
  findIdsNeedingReconcile(now: Date, limit: number): Promise<string[]>;
  /**
   * Submitted sessions still waiting for evaluation since before `submittedBefore`, oldest first;
   * the sweeper re-creates the evaluation job if the process died between commit and enqueue.
   */
  findAwaitingEvaluation(submittedBefore: Date, limit: number): Promise<string[]>;
  findPreSubmitForBrief(briefId: string): Promise<InterviewRecord[]>;
  /** Terminal pre-submit sessions last updated before `cutoff` and not yet minimised. */
  findTerminalToMinimize(cutoff: Date, limit: number): Promise<string[]>;
  /** Hard delete sessions invited before `cutoff` (retention ceiling); returns their ids. */
  /** `except`: sessions under a moderator dispute hold (Section 24) are kept. */
  deleteInvitedBefore(cutoff: Date, except?: ReadonlySet<string>): Promise<string[]>;
}

export interface EvaluationJobStore {
  /** Idempotent per session: returns the existing job when one exists. */
  enqueue(job: EvaluationJobRecord): Promise<EvaluationJobRecord>;
  findBySession(sessionId: string): Promise<EvaluationJobRecord | null>;
  /** Claims the next runnable job (queued and due, or running with an expired lease). */
  claim(now: Date, owner: string, leaseMs: number): Promise<EvaluationJobRecord | null>;
  /** Saves step results while the caller still holds the lease. */
  saveSteps(
    jobId: string,
    owner: string,
    steps: EvaluationSteps,
    leaseUntil: Date,
  ): Promise<boolean>;
  finish(
    jobId: string,
    owner: string,
    status: 'succeeded' | 'failed',
    lastErrorCode: string | null,
    at: Date,
  ): Promise<boolean>;
  reschedule(
    jobId: string,
    owner: string,
    nextRunAt: Date,
    lastErrorCode: string,
  ): Promise<boolean>;
  /** Failed -> queued with a fresh attempt budget (manual retry). Null when not failed. */
  requeue(sessionId: string, now: Date, maxAttempts: number): Promise<EvaluationJobRecord | null>;
  cancel(sessionId: string, at: Date): Promise<void>;
  deleteForSession(sessionId: string): Promise<void>;
}

export interface ReportStore {
  /** Idempotent on (sessionId, version). */
  insert(report: ReportRecord): Promise<ReportRecord>;
  findLatest(sessionId: string): Promise<ReportRecord | null>;
  deleteForSession(sessionId: string): Promise<void>;
}

// --- MongoDB -------------------------------------------------------------------------------------

const oid = (id: string) => new mongoose.Types.ObjectId(id);
const hex = (v: unknown) => (v as mongoose.Types.ObjectId).toHexString();

type InterviewDoc = Omit<
  InterviewRecord,
  'id' | 'briefId' | 'candidateUserId' | 'founderUserId' | 'recommendationBatchId'
> & {
  _id: mongoose.Types.ObjectId;
  briefId: mongoose.Types.ObjectId;
  candidateUserId: mongoose.Types.ObjectId;
  founderUserId: mongoose.Types.ObjectId;
  recommendationBatchId: mongoose.Types.ObjectId;
};

function toDoc(r: InterviewRecord): InterviewDoc {
  const { id, briefId, candidateUserId, founderUserId, recommendationBatchId, ...rest } = r;
  return {
    ...rest,
    _id: oid(id),
    briefId: oid(briefId),
    candidateUserId: oid(candidateUserId),
    founderUserId: oid(founderUserId),
    recommendationBatchId: oid(recommendationBatchId),
  };
}

function fromDoc(d: InterviewDoc): InterviewRecord {
  const { _id, briefId, candidateUserId, founderUserId, recommendationBatchId, ...rest } = d;
  return {
    ...(rest as Omit<
      InterviewRecord,
      'id' | 'briefId' | 'candidateUserId' | 'founderUserId' | 'recommendationBatchId'
    >),
    id: hex(_id),
    briefId: hex(briefId),
    candidateUserId: hex(candidateUserId),
    founderUserId: hex(founderUserId),
    recommendationBatchId: hex(recommendationBatchId),
  };
}

const isDuplicate = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;

export const PRE_SUBMIT_STATUSES: InterviewStatus[] = [
  'invited',
  'accepted',
  'in_progress',
  'coding',
];

export function createMongoInterviewStore(conn: Connection): InterviewStore {
  const col = () => conn.db!.collection<InterviewDoc>('interview_sessions');
  return {
    async insert(record) {
      try {
        await col().insertOne(toDoc(record));
        return 'created';
      } catch (err) {
        if (!isDuplicate(err)) throw err;
        const same = await col().findOne({ _id: oid(record.id) });
        return same ? 'exists' : 'duplicate_pair';
      }
    },
    async findById(id) {
      const d = await col().findOne({ _id: oid(id) });
      return d ? fromDoc(d) : null;
    },
    async findByPair(briefId, candidateUserId) {
      const d = await col().findOne({
        briefId: oid(briefId),
        candidateUserId: oid(candidateUserId),
      });
      return d ? fromDoc(d) : null;
    },
    async countInvitedSince(founderUserId, since) {
      return col().countDocuments({
        founderUserId: oid(founderUserId),
        invitedAt: { $gte: since },
      });
    },
    async list(filter, page) {
      const q: mongo.Filter<InterviewDoc> = {};
      if (filter.founderUserId) q.founderUserId = oid(filter.founderUserId);
      if (filter.candidateUserId) q.candidateUserId = oid(filter.candidateUserId);
      if (filter.briefId) q.briefId = oid(filter.briefId);
      if (filter.status) q.status = filter.status;
      if (page.after) {
        q.$or = [
          { invitedAt: { $lt: page.after.invitedAt } },
          { invitedAt: page.after.invitedAt, _id: { $lt: oid(page.after.id) } },
        ];
      }
      const docs = await col()
        .find(q)
        .sort({ invitedAt: -1, _id: -1 })
        .limit(page.limit + 1)
        .toArray();
      return docs.map(fromDoc);
    },
    async replace(next, expectedRev) {
      const doc = toDoc({ ...next, rev: expectedRev + 1 });
      const { _id, ...body } = doc;
      const res = await col().findOneAndReplace({ _id, rev: expectedRev }, body, {
        returnDocument: 'after',
      });
      return res ? fromDoc(res) : null;
    },
    async findIdsNeedingReconcile(now, limit) {
      const docs = await col()
        .find(
          {
            $or: [
              { status: { $in: ['invited', 'accepted'] }, expiresAt: { $lte: now } },
              { status: 'in_progress', conversationDeadline: { $lte: now } },
              { status: { $in: ['in_progress', 'coding'] }, globalDeadline: { $lte: now } },
              { status: 'coding', codingDeadline: { $lte: now } },
              {
                'generation.status': 'running',
                'generation.leaseUntil': { $lte: now.toISOString() },
              },
              { status: 'submitted', evaluationStatus: 'none' },
            ],
          },
          { projection: { _id: 1 } },
        )
        .limit(limit)
        .toArray();
      return docs.map((d) => hex(d._id));
    },
    async findAwaitingEvaluation(submittedBefore, limit) {
      const docs = await col()
        .find(
          {
            status: 'submitted',
            evaluationStatus: 'queued',
            submittedAt: { $lte: submittedBefore },
          },
          { projection: { _id: 1 } },
        )
        .sort({ submittedAt: 1 })
        .limit(limit)
        .toArray();
      return docs.map((d) => hex(d._id));
    },
    async findPreSubmitForBrief(briefId) {
      const docs = await col()
        .find({ briefId: oid(briefId), status: { $in: PRE_SUBMIT_STATUSES } })
        .toArray();
      return docs.map(fromDoc);
    },
    async findTerminalToMinimize(cutoff, limit) {
      const docs = await col()
        .find(
          {
            status: { $in: ['declined', 'expired', 'cancelled'] },
            minimizedAt: null,
            updatedAt: { $lt: cutoff },
          },
          { projection: { _id: 1 } },
        )
        .limit(limit)
        .toArray();
      return docs.map((d) => hex(d._id));
    },
    async deleteInvitedBefore(cutoff, except) {
      const docs = (
        await col()
          .find({ invitedAt: { $lt: cutoff } }, { projection: { _id: 1 } })
          .toArray()
      ).filter((d) => !except?.has(hex(d._id)));
      if (docs.length === 0) return [];
      await col().deleteMany({ _id: { $in: docs.map((d) => d._id) } });
      return docs.map((d) => hex(d._id));
    },
  };
}

type JobDoc = Omit<EvaluationJobRecord, 'id' | 'sessionId' | 'founderUserId'> & {
  _id: mongoose.Types.ObjectId;
  sessionId: mongoose.Types.ObjectId;
  founderUserId: mongoose.Types.ObjectId;
};

function jobFromDoc(d: JobDoc): EvaluationJobRecord {
  const { _id, sessionId, founderUserId, ...rest } = d;
  return { ...rest, id: hex(_id), sessionId: hex(sessionId), founderUserId: hex(founderUserId) };
}

export function createMongoEvaluationJobStore(conn: Connection): EvaluationJobStore {
  const col = (): mongo.Collection<JobDoc> => conn.db!.collection<JobDoc>('evaluation_jobs');
  return {
    async enqueue(job) {
      const { id, sessionId, founderUserId, ...rest } = job;
      try {
        await col().insertOne({
          ...rest,
          _id: oid(id),
          sessionId: oid(sessionId),
          founderUserId: oid(founderUserId),
        });
        return job;
      } catch (err) {
        if (!isDuplicate(err)) throw err;
        const existing = await col().findOne({ sessionId: oid(sessionId) });
        if (!existing) throw err;
        return jobFromDoc(existing);
      }
    },
    async findBySession(sessionId) {
      const d = await col().findOne({ sessionId: oid(sessionId) });
      return d ? jobFromDoc(d) : null;
    },
    async claim(now, owner, leaseMs) {
      const res = await col().findOneAndUpdate(
        {
          $or: [
            { status: 'queued', nextRunAt: { $lte: now } },
            { status: 'running', leaseUntil: { $lte: now } },
          ],
        },
        {
          $set: {
            status: 'running',
            leaseOwner: owner,
            leaseUntil: new Date(now.getTime() + leaseMs),
            updatedAt: now,
          },
          $inc: { attempts: 1 },
        },
        { sort: { nextRunAt: 1 }, returnDocument: 'after' },
      );
      return res ? jobFromDoc(res) : null;
    },
    async saveSteps(jobId, owner, steps, leaseUntil) {
      const res = await col().updateOne(
        { _id: oid(jobId), leaseOwner: owner, status: 'running' },
        { $set: { steps, leaseUntil, updatedAt: new Date() } },
      );
      return res.modifiedCount === 1;
    },
    async finish(jobId, owner, status, lastErrorCode, at) {
      const res = await col().updateOne(
        { _id: oid(jobId), leaseOwner: owner, status: 'running' },
        {
          $set: {
            status,
            lastErrorCode,
            finishedAt: at,
            leaseOwner: null,
            leaseUntil: null,
            updatedAt: at,
          },
        },
      );
      return res.modifiedCount === 1;
    },
    async reschedule(jobId, owner, nextRunAt, lastErrorCode) {
      const res = await col().updateOne(
        { _id: oid(jobId), leaseOwner: owner, status: 'running' },
        {
          $set: {
            status: 'queued',
            nextRunAt,
            lastErrorCode,
            leaseOwner: null,
            leaseUntil: null,
            updatedAt: new Date(),
          },
        },
      );
      return res.modifiedCount === 1;
    },
    async requeue(sessionId, now, maxAttempts) {
      const res = await col().findOneAndUpdate(
        { sessionId: oid(sessionId), status: 'failed' },
        {
          $set: {
            status: 'queued',
            attempts: 0,
            maxAttempts,
            nextRunAt: now,
            finishedAt: null,
            updatedAt: now,
          },
        },
        { returnDocument: 'after' },
      );
      return res ? jobFromDoc(res) : null;
    },
    async cancel(sessionId, at) {
      await col().updateOne(
        { sessionId: oid(sessionId), status: { $in: ['queued', 'running', 'failed'] } },
        {
          $set: {
            status: 'cancelled',
            leaseOwner: null,
            leaseUntil: null,
            finishedAt: at,
            updatedAt: at,
          },
        },
      );
    },
    async deleteForSession(sessionId) {
      await col().deleteMany({ sessionId: oid(sessionId) });
    },
  };
}

type ReportDoc = Omit<ReportRecord, 'id' | 'sessionId'> & {
  _id: mongoose.Types.ObjectId;
  sessionId: mongoose.Types.ObjectId;
};

export function createMongoReportStore(conn: Connection): ReportStore {
  const col = () => conn.db!.collection<ReportDoc>('interview_reports');
  const from = (d: ReportDoc): ReportRecord => {
    const { _id, sessionId, ...rest } = d;
    return { ...rest, id: hex(_id), sessionId: hex(sessionId) };
  };
  return {
    async insert(report) {
      const { id, sessionId, ...rest } = report;
      try {
        await col().insertOne({ ...rest, _id: oid(id), sessionId: oid(sessionId) });
        return report;
      } catch (err) {
        if (!isDuplicate(err)) throw err;
        const existing = await col().findOne({
          sessionId: oid(sessionId),
          version: report.version,
        });
        if (!existing) throw err;
        return from(existing);
      }
    },
    async findLatest(sessionId) {
      const d = await col()
        .find({ sessionId: oid(sessionId) })
        .sort({ version: -1 })
        .limit(1)
        .next();
      return d ? from(d) : null;
    },
    async deleteForSession(sessionId) {
      await col().deleteMany({ sessionId: oid(sessionId) });
    },
  };
}
