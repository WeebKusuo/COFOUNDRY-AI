import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog, createMongoAuditStore } from '../src/audit/audit.js';
import type { UserRecord } from '../src/auth/store.js';
import type { InterviewFacts } from '../src/collaboration/common.js';
import { CollaborationService } from '../src/collaboration/requests.js';
import {
  createMongoMatchRequestStore,
  createMongoMatchStore,
  createMongoSprintStore,
  type MatchRequestStore,
  type MatchStore,
  type SprintStore,
} from '../src/collaboration/store.js';
import { DEMO_BRIEFS, DEMO_CANDIDATE_PROFILES } from '../src/db/demo-accounts.js';
import { checkTransactionSupport } from '../src/db/mongo.js';
import { runMigrations } from '../src/db/migrations.js';
import { createMongoTransactionRunner } from '../src/db/transactions.js';
import {
  createMongoBlockStore,
  createMongoRelationshipGuardStore,
  createMongoSafetyCaseStore,
  type BlockStore,
} from '../src/safety/store.js';
import { silentLogger } from './helpers.js';
import { openTestDb, expectTransactions, type TestDb } from './support/db.js';
import { addTestUser } from './support/harness.js';
import { MemoryBriefStore } from './support/memory-brief-store.js';
import { MemoryProfileStore } from './support/memory-profile-store.js';
import { MemoryIdentityStore } from './support/memory-store.js';

/**
 * Phases 11-14 against a real MongoDB-protocol server: migration 8 indexes, the lifetime
 * uniqueness rules, conditional replaces and the collaboration service over the Mongo stores
 * (including concurrent accepts). The rollback test needs real multi-document transactions and is
 * skipped when the test server lacks them (FerretDB does) — it does NOT pass there by accident.
 */

let db: TestDb;
let requests: MatchRequestStore;
let matches: MatchStore;
let sprints: SprintStore;
let blocks: BlockStore;
let atomic = false;
const oid = () => new mongoose.Types.ObjectId().toHexString();

beforeAll(async () => {
  db = await openTestDb('collab');
  await runMigrations(db.conn, silentLogger);
  requests = createMongoMatchRequestStore(db.conn);
  matches = createMongoMatchStore(db.conn);
  sprints = createMongoSprintStore(db.conn);
  blocks = createMongoBlockStore(db.conn);
  atomic = (await checkTransactionSupport(db.conn)).supported;
});

afterAll(async () => {
  await db?.close();
});

async function graph() {
  const ids = new MemoryIdentityStore();
  const founder = await addTestUser(ids, `f-${oid()}@demo.test`, ['founder'], { cohortId: 'c' });
  const candidate = await addTestUser(ids, `c-${oid()}@demo.test`, ['candidate'], {
    cohortId: 'c',
  });
  const pstore = new MemoryProfileStore();
  const fixture = DEMO_CANDIDATE_PROFILES['demo:candidate:asha']!;
  pstore.candidates.set(candidate.id, {
    userId: candidate.id,
    revision: 1,
    headline: fixture.headline,
    bio: fixture.bio,
    skills: fixture.skills,
    industryTags: fixture.industryTags,
    missionTags: fixture.missionTags,
    availableHoursPerWeek: fixture.availableHoursPerWeek,
    commitmentMonths: fixture.commitmentMonths,
    opportunityTypes: ['contributor'],
    projects: [],
    discoveryEnabled: true,
    updatedAt: new Date(),
  });
  const briefStore = new MemoryBriefStore();
  const { record } = await briefStore.insertDraft({
    id: oid(),
    founderUserId: founder.id,
    fields: DEMO_BRIEFS[0]!.fields,
    clonedFromId: null,
  });
  await briefStore.publish(
    record.id,
    founder.id,
    0,
    { compensation: record.compensation },
    new Date(),
  );
  const interviewId = oid();
  const facts: InterviewFacts = {
    interviewId,
    founderUserId: founder.id,
    candidateUserId: candidate.id,
    briefId: record.id,
    evaluated: true,
    consentActive: true,
    quarantined: false,
    blocked: false,
    reportVersion: 1,
    overallScore: 80,
    evidenceLevel: 'strong',
  };
  const tx = createMongoTransactionRunner(db.conn, { atomic });
  const service = new CollaborationService({
    requests,
    matches,
    sprints,
    blocks,
    guards: createMongoRelationshipGuardStore(db.conn),
    tx,
    identity: ids,
    briefStore,
    profiles: pstore,
    interviews: { collaborationFacts: async (id) => (id === interviewId ? facts : null) },
    audit: new AuditLog(createMongoAuditStore(db.conn)),
  });
  return { service, founder, candidate, briefId: record.id, interviewId };
}

const create = (g: Awaited<ReturnType<typeof graph>>, id = oid()) =>
  g.service.createRequest(
    g.founder as UserRecord,
    {
      briefId: g.briefId,
      interviewId: g.interviewId,
      candidateUserId: g.candidate.id,
      message: 'hi',
    },
    id,
  );

describe('migration 8 and Mongo stores', () => {
  it('creates the Phase 11-14 indexes', async () => {
    const names = async (c: string) =>
      (await db.conn.db!.collection(c).indexes()).map((i) => i.name);
    expect(await names('match_requests')).toEqual(
      expect.arrayContaining(['brief_candidate_unique', 'candidate_status', 'status_expiresAt']),
    );
    expect(await names('matches')).toEqual(
      expect.arrayContaining(['requestId_unique', 'brief_candidate_unique']),
    );
    expect(await names('trial_sprints')).toEqual(
      expect.arrayContaining(['matchId_unique', 'status_deadline']),
    );
    expect(await names('blocks')).toEqual(expect.arrayContaining(['directed_pair_unique']));
    expect(await names('safety_cases')).toEqual(
      expect.arrayContaining(['status_createdAt', 'target']),
    );
    expect(await names('audit_events')).toEqual(expect.arrayContaining(['time']));
  });

  it('enforces one request per brief/candidate pair at the database', async () => {
    const g = await graph();
    const first = await create(g);
    const rec = (await requests.findById(first.id))!;
    expect(await requests.insert({ ...rec, id: oid() })).toBe('duplicate');
    expect(await requests.insert(rec)).toBe('exists');
    expect(await requests.replace({ ...rec, message: 'x' }, rec.rev + 5)).toBeNull();
    const saved = await requests.replace({ ...rec, message: 'x' }, rec.rev);
    expect(saved).toMatchObject({ message: 'x', rev: rec.rev + 1 });
  });

  it('two concurrent accepts over the Mongo stores create exactly one match', async () => {
    const g = await graph();
    const req = await create(g);
    const results = await Promise.allSettled([
      g.service.accept(g.candidate as UserRecord, req.id),
      g.service.accept(g.candidate as UserRecord, req.id),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const matchIds = new Set(
      ok.map((r) => (r as PromiseFulfilledResult<{ match: { id: string } }>).value.match.id),
    );
    expect(matchIds.size).toBe(1);
    expect(
      await db.conn
        .db!.collection('matches')
        .countDocuments({ requestId: new mongoose.Types.ObjectId(req.id) }),
    ).toBe(1);
    // The pair can never get a second match, even with a different request id.
    const m = (await matches.findByRequest(req.id))!;
    expect(await matches.insert({ ...m, id: oid(), requestId: oid() })).toBe('duplicate');
  });

  it.skipIf(!expectTransactions)(
    'rolls the acceptance back when the match insert fails (real transaction required)',
    async () => {
      const g = await graph();
      const req = await create(g);
      const original = matches.insert;
      matches.insert = async () => {
        throw new Error('simulated failure');
      };
      try {
        await expect(g.service.accept(g.candidate as UserRecord, req.id)).rejects.toThrow();
      } finally {
        matches.insert = original;
      }
      expect((await requests.findById(req.id))!.status).toBe('pending');
    },
  );

  it('blocks are directed and idempotent; either direction counts', async () => {
    const a = oid();
    const b = oid();
    const at = new Date();
    const first = await blocks.insert({
      id: oid(),
      blockerUserId: a,
      blockedUserId: b,
      createdAt: at,
    });
    const again = await blocks.insert({
      id: oid(),
      blockerUserId: a,
      blockedUserId: b,
      createdAt: at,
    });
    expect(again.id).toBe(first.id);
    expect(await blocks.existsEither(b, a)).toBe(true);
    expect([...(await blocks.blockedAmong(b, [a, oid()]))]).toEqual([a]);
    expect(await blocks.remove(b, a)).toBe(false); // only the blocker's own record
    expect(await blocks.remove(a, b)).toBe(true);
    expect(await blocks.existsEither(a, b)).toBe(false);
  });

  it('the relationship guard row is shared by both orderings of a pair', async () => {
    const guards = createMongoRelationshipGuardStore(db.conn);
    const a = oid();
    const b = oid();
    const r1 = await guards.touch(a, b);
    const r2 = await guards.touch(b, a);
    expect(r2).toBe(r1 + 1);
  });

  it('finds due sprints by ISO deadline, review and acknowledgement windows', async () => {
    const g = await graph();
    const req = await create(g);
    const { match } = await g.service.accept(g.candidate as UserRecord, req.id);
    const now = new Date();
    const base = {
      rev: 0,
      matchId: match.id,
      founderUserId: g.founder.id,
      candidateUserId: g.candidate.id,
      proposerUserId: g.founder.id,
      contributorUserId: g.candidate.id,
      reviewerUserId: g.founder.id,
      version: 1,
      termsHash: 'h',
      terms: {
        title: 't',
        scope: 's',
        deliverables: ['d'],
        criteria: [{ id: 'c1', text: 'c' }],
        expectedHours: 2,
        deadline: new Date(now.getTime() - 1000).toISOString(),
        compensation: { type: 'unpaid' as const },
        ipPolicyVersion: 'creator-owned-v3.0' as const,
      },
      minimumCompensation: { type: 'unpaid' as const },
      approvals: [],
      history: [],
      status: 'active' as const,
      sentAt: null,
      startedAt: now,
      submittedAt: null,
      reviewedAt: null,
      completedAt: null,
      cancelledAt: null,
      submission: null,
      review: null,
      acknowledgements: [],
      terminalReason: null,
      terminalNote: null,
      timeline: [],
      createdAt: now,
      updatedAt: now,
    };
    const id = oid();
    expect(await sprints.insert({ ...base, id })).toBe('created');
    expect(await sprints.insert({ ...base, id: oid() })).toBe('duplicate'); // one per match
    const due = await sprints.findDueIds(now, new Date(now.getTime() - 7 * 86400_000), now, 10);
    expect(due).toContain(id);
  });

  it('safety cases list newest first and find open duplicates', async () => {
    const cases = createMongoSafetyCaseStore(db.conn);
    const reporter = oid();
    const target = oid();
    const mk = (createdAt: Date, status: 'open' | 'resolved') => ({
      id: oid(),
      rev: 0,
      kind: 'report' as const,
      category: 'other' as const,
      reporterUserId: reporter,
      targetUserId: target,
      targetType: 'user' as const,
      targetId: target,
      text: 'Something happened here',
      status,
      assignedModeratorId: null,
      resolutionText: null,
      correctionOverlay: null,
      quarantinedReport: false,
      suspendedTarget: false,
      hold: null,
      notes: [],
      openedAt: createdAt,
      resolvedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
    const older = mk(new Date(Date.UTC(2026, 9, 1)), 'resolved');
    const newer = mk(new Date(Date.UTC(2026, 9, 2)), 'open');
    await cases.insert(older);
    await cases.insert(newer);
    const page = await cases.list({ reporterUserId: reporter }, { after: null, limit: 10 });
    expect(page.map((c) => c.id)).toEqual([newer.id, older.id]);
    expect((await cases.findOpenDuplicate(reporter, 'report', 'user', target))?.id).toBe(newer.id);
  });
});
