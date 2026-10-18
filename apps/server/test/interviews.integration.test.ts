import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrations.js';
import {
  IDLE_GENERATION,
  type EvaluationJobRecord,
  type InterviewRecord,
} from '../src/interviews/records.js';
import {
  createMongoEvaluationJobStore,
  createMongoInterviewStore,
  createMongoReportStore,
  type EvaluationJobStore,
  type InterviewStore,
  type ReportStore,
} from '../src/interviews/store.js';
import { silentLogger } from './helpers.js';
import { openTestDb, type TestDb } from './support/db.js';

/**
 * The MongoDB interview stores must behave exactly like the in-memory stores the service tests
 * use: unique brief/candidate pairs, conditional replace on rev, newest-first paging, the
 * reconcile query, leased job claims and idempotent reports. Full HTTP flows over these stores
 * run in the Playwright E2E suite (e2e/start-server.ts uses the Mongo stores).
 */

let db: TestDb;
let store: InterviewStore;
let jobs: EvaluationJobStore;
let reports: ReportStore;
const id = () => new mongoose.Types.ObjectId().toHexString();

function record(over: Partial<InterviewRecord> = {}): InterviewRecord {
  const now = new Date('2026-10-17T10:00:00Z');
  return {
    id: id(),
    rev: 0,
    briefId: id(),
    briefVersion: 1,
    candidateUserId: id(),
    founderUserId: id(),
    recommendationBatchId: id(),
    status: 'invited',
    evaluationStatus: 'none',
    invitedAt: now,
    expiresAt: new Date(now.getTime() + 7 * 86400_000),
    briefPreview: { title: 'T' } as never,
    briefFull: { id: 'x' } as never,
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
    ...over,
  };
}

beforeAll(async () => {
  db = await openTestDb('interviews');
  await runMigrations(db.conn, silentLogger);
  store = createMongoInterviewStore(db.conn);
  jobs = createMongoEvaluationJobStore(db.conn);
  reports = createMongoReportStore(db.conn);
});

afterAll(async () => {
  await db?.close();
});

describe('Mongo interview store', () => {
  it('creates the migration 7 indexes', async () => {
    const names = (await db.conn.db!.collection('interview_sessions').indexes()).map((i) => i.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'brief_candidate_unique',
        'founder_invitedAt',
        'candidate_invitedAt',
        'status_expiresAt',
        'status_evaluation_submittedAt',
      ]),
    );
    const jobIdx = await db.conn.db!.collection('evaluation_jobs').indexes();
    expect(jobIdx.find((i) => i.name === 'sessionId_unique')).toMatchObject({ unique: true });
  });

  it('enforces one interview per brief/candidate pair and idempotent inserts', async () => {
    const r = record();
    expect(await store.insert(r)).toBe('created');
    expect(await store.insert(r)).toBe('exists');
    expect(
      await store.insert(record({ briefId: r.briefId, candidateUserId: r.candidateUserId })),
    ).toBe('duplicate_pair');
    expect((await store.findByPair(r.briefId, r.candidateUserId))!.id).toBe(r.id);
  });

  it('replaces only when the revision matches and round-trips nested data', async () => {
    const r = record();
    await store.insert(r);
    const turns = [
      { index: 0, kind: 'intro', prompt: 'Hello', askedAt: '2026-10-17T10:00:00.000Z' },
    ] as never;
    const saved = await store.replace({ ...r, status: 'in_progress', turns }, 0);
    expect(saved).toMatchObject({ rev: 1, status: 'in_progress', turns: [{ prompt: 'Hello' }] });
    expect(await store.replace({ ...r, status: 'cancelled' }, 0)).toBeNull();
    expect((await store.findById(r.id))!.status).toBe('in_progress');
  });

  it('lists newest first with a stable cursor and counts daily invitations', async () => {
    const founder = id();
    const base = new Date('2026-10-18T10:00:00Z').getTime();
    for (let i = 0; i < 3; i += 1)
      await store.insert(record({ founderUserId: founder, invitedAt: new Date(base + i * 1000) }));
    const first = await store.list({ founderUserId: founder }, { after: null, limit: 2 });
    expect(first).toHaveLength(3);
    const next = await store.list(
      { founderUserId: founder },
      { after: { invitedAt: first[1]!.invitedAt, id: first[1]!.id }, limit: 2 },
    );
    expect(next.map((r) => r.id)).toEqual([first[2]!.id]);
    expect(await store.countInvitedSince(founder, new Date(base + 500))).toBe(2);
  });

  it('finds sessions needing reconciliation', async () => {
    const now = new Date('2026-12-01T00:00:00Z');
    const due = record({ expiresAt: new Date(now.getTime() - 1) });
    const lease = record({
      status: 'in_progress',
      conversationDeadline: new Date(now.getTime() + 60_000),
      globalDeadline: new Date(now.getTime() + 60_000),
      generation: {
        ...IDLE_GENERATION,
        status: 'running',
        leaseUntil: new Date(now.getTime() - 1).toISOString(),
      },
    });
    const fine = record({ expiresAt: new Date(now.getTime() + 86400_000) });
    for (const r of [due, lease, fine]) await store.insert(r);
    const ids = await store.findIdsNeedingReconcile(now, 100);
    expect(ids).toEqual(expect.arrayContaining([due.id, lease.id]));
    expect(ids).not.toContain(fine.id);
  });

  it('finds submitted sessions still waiting for evaluation, oldest first', async () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 17, 11, m));
    const old = record({ status: 'submitted', evaluationStatus: 'queued', submittedAt: at(1) });
    const older = record({ status: 'submitted', evaluationStatus: 'queued', submittedAt: at(0) });
    const fresh = record({ status: 'submitted', evaluationStatus: 'queued', submittedAt: at(9) });
    const done = record({ status: 'submitted', evaluationStatus: 'succeeded', submittedAt: at(0) });
    for (const r of [old, older, fresh, done]) await store.insert(r);
    const ids = await store.findAwaitingEvaluation(at(5), 100);
    expect(ids.filter((i) => [old.id, older.id, fresh.id, done.id].includes(i))).toEqual([
      older.id,
      old.id,
    ]);
  });
});

describe('Mongo evaluation jobs and reports', () => {
  const job = (sessionId: string): EvaluationJobRecord => {
    const at = new Date('2026-10-17T10:00:00Z');
    return {
      id: id(),
      sessionId,
      founderUserId: id(),
      status: 'queued',
      attempts: 0,
      maxAttempts: 2,
      nextRunAt: at,
      leaseOwner: null,
      leaseUntil: null,
      lastErrorCode: null,
      steps: { answers: {}, communication: null, codeGrade: null, codeReview: null },
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
    };
  };

  it('enqueues once per session, claims with a lease and only the owner can save', async () => {
    const sessionId = id();
    const j = job(sessionId);
    await jobs.enqueue(j);
    expect((await jobs.enqueue(job(sessionId))).id).toBe(j.id);
    const now = new Date('2026-10-17T10:00:05Z');
    const claimed = (await jobs.claim(now, 'w1', 60_000))!;
    expect(claimed).toMatchObject({ id: j.id, status: 'running', attempts: 1, leaseOwner: 'w1' });
    expect(await jobs.claim(now, 'w2', 60_000)).toBeNull();
    const steps = {
      answers: { '1': { status: 'skipped' } },
      communication: null,
      codeGrade: null,
      codeReview: null,
    } as never;
    expect(await jobs.saveSteps(j.id, 'w2', steps, now)).toBe(false);
    expect(await jobs.saveSteps(j.id, 'w1', steps, new Date(now.getTime() + 60_000))).toBe(true);
    // An expired lease can be taken over after a crash.
    const takeover = (await jobs.claim(new Date(now.getTime() + 120_000), 'w2', 60_000))!;
    expect(takeover).toMatchObject({
      leaseOwner: 'w2',
      attempts: 2,
      steps: { answers: { '1': { status: 'skipped' } } },
    });
    expect(await jobs.finish(j.id, 'w1', 'succeeded', null, now)).toBe(false);
    expect(await jobs.finish(j.id, 'w2', 'failed', 'upstream_failed', now)).toBe(true);
    expect((await jobs.requeue(sessionId, now, 4))!).toMatchObject({
      status: 'queued',
      attempts: 0,
      maxAttempts: 4,
    });
    await jobs.cancel(sessionId, now);
    expect((await jobs.findBySession(sessionId))!.status).toBe('cancelled');
  });

  it('stores immutable report versions idempotently', async () => {
    const sessionId = id();
    const r1 = {
      id: id(),
      sessionId,
      version: 1,
      rubricVersion: 'rubric-interview-v1',
      generatedAt: new Date(),
      data: { summary: 'a' },
    };
    await reports.insert(r1);
    expect((await reports.insert({ ...r1, id: id(), data: { summary: 'b' } })).data).toEqual({
      summary: 'a',
    });
    await reports.insert({ ...r1, id: id(), version: 2, data: { summary: 'c' } });
    expect((await reports.findLatest(sessionId))!).toMatchObject({
      version: 2,
      data: { summary: 'c' },
    });
  });
});
