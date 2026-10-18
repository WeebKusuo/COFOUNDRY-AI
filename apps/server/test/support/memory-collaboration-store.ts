import type { AuditStore } from '../../src/audit/audit.js';
import type { PageRequest } from '../../src/briefs/store.js';
import type {
  MatchRecord,
  MatchRequestRecord,
  TrialSprintRecord,
} from '../../src/collaboration/records.js';
import type {
  InsertResult,
  MatchRequestStore,
  MatchStore,
  SprintStore,
} from '../../src/collaboration/store.js';
import { NO_TX, type TransactionRunner, type Tx } from '../../src/db/transactions.js';
import type { AuditEventRecord, BlockRecord, SafetyCaseRecord } from '../../src/safety/records.js';
import {
  guardKey,
  type BlockStore,
  type RelationshipGuardStore,
  type SafetyCaseStore,
} from '../../src/safety/store.js';

/**
 * In-memory stores for Phases 11-14 with the same unique constraints as migration 8, plus a
 * transaction runner that serialises transactions and rolls back every participating store on
 * error. Real MongoDB transaction behaviour is covered by collaboration.integration.test.ts
 * (skipped when the test server has no transaction support — FerretDB does not).
 */

const c = <T>(v: T): T => structuredClone(v);

interface Snapshottable {
  snapshot(): unknown;
  restore(s: unknown): void;
}

class Records<R extends { id: string; createdAt: Date }> implements Snapshottable {
  rows = new Map<string, R>();
  constructor(private readonly uniques: Array<(r: R) => string | null>) {}

  snapshot() {
    return c([...this.rows.entries()]);
  }
  restore(s: unknown) {
    this.rows = new Map(s as Array<[string, R]>);
  }

  insert(r: R): InsertResult {
    if (this.rows.has(r.id)) return 'exists';
    for (const u of this.uniques) {
      const k = u(r);
      if (k !== null && [...this.rows.values()].some((x) => u(x) === k)) return 'duplicate';
    }
    this.rows.set(r.id, c(r));
    return 'created';
  }
  get(id: string): R | null {
    const r = this.rows.get(id);
    return r ? c(r) : null;
  }
  where(p: (r: R) => boolean): R[] {
    return [...this.rows.values()].filter(p).map(c);
  }
  replace(next: R & { rev: number }, rev: number): R | null {
    const cur = this.rows.get(next.id) as (R & { rev: number }) | undefined;
    if (!cur || cur.rev !== rev) return null;
    const saved = { ...c(next), rev: rev + 1 };
    this.rows.set(next.id, saved);
    return c(saved);
  }
  page(p: (r: R) => boolean, page: PageRequest): R[] {
    return this.where(p)
      .filter(
        (r) =>
          !page.after ||
          r.createdAt < page.after.createdAt ||
          (r.createdAt.getTime() === page.after.createdAt.getTime() && r.id < page.after.id),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
      .slice(0, page.limit + 1);
  }
}

const involving =
  (userId: string, other?: string) => (r: { founderUserId: string; candidateUserId: string }) =>
    other
      ? (r.founderUserId === userId && r.candidateUserId === other) ||
        (r.founderUserId === other && r.candidateUserId === userId)
      : r.founderUserId === userId || r.candidateUserId === userId;

export class MemoryMatchRequestStore implements MatchRequestStore, Snapshottable {
  readonly t = new Records<MatchRequestRecord>([(r) => `${r.briefId}:${r.candidateUserId}`]);
  snapshot = () => this.t.snapshot();
  restore = (s: unknown) => this.t.restore(s);
  async insert(r: MatchRequestRecord) {
    return this.t.insert(r);
  }
  async findById(id: string) {
    return this.t.get(id);
  }
  async findByPair(briefId: string, candidateUserId: string) {
    return (
      this.t.where((r) => r.briefId === briefId && r.candidateUserId === candidateUserId)[0] ?? null
    );
  }
  async replace(next: MatchRequestRecord, rev: number) {
    return this.t.replace(next, rev);
  }
  async list(
    f: {
      founderUserId?: string;
      candidateUserId?: string;
      status?: MatchRequestRecord['status'];
      interviewId?: string;
    },
    page: PageRequest,
  ) {
    return this.t.page(
      (r) =>
        (!f.founderUserId || r.founderUserId === f.founderUserId) &&
        (!f.candidateUserId || r.candidateUserId === f.candidateUserId) &&
        (!f.status || r.status === f.status) &&
        (!f.interviewId || r.interviewId === f.interviewId),
      page,
    );
  }
  async countCreatedSince(founderUserId: string, since: Date) {
    return this.t.where((r) => r.founderUserId === founderUserId && r.createdAt >= since).length;
  }
  async findPendingInvolving(userId: string, other?: string) {
    return this.t.where((r) => r.status === 'pending' && involving(userId, other)(r));
  }
  async findPendingForBrief(briefId: string) {
    return this.t.where((r) => r.briefId === briefId && r.status === 'pending');
  }
  async findExpiredPendingIds(now: Date, limit: number) {
    return this.t
      .where((r) => r.status === 'pending' && r.expiresAt <= now)
      .slice(0, limit)
      .map((r) => r.id);
  }
  async findRecentlyAcceptedIds(since: Date, limit: number) {
    return this.t
      .where((r) => r.status === 'accepted' && !!r.respondedAt && r.respondedAt >= since)
      .slice(0, limit)
      .map((r) => r.id);
  }
}

export class MemoryMatchStore implements MatchStore, Snapshottable {
  readonly t = new Records<MatchRecord>([
    (m) => `req:${m.requestId}`,
    (m) => `pair:${m.briefId}:${m.candidateUserId}`,
  ]);
  snapshot = () => this.t.snapshot();
  restore = (s: unknown) => this.t.restore(s);
  async insert(m: MatchRecord) {
    return this.t.insert(m);
  }
  async findById(id: string) {
    return this.t.get(id);
  }
  async findByRequest(requestId: string) {
    return this.t.where((m) => m.requestId === requestId)[0] ?? null;
  }
  async replace(next: MatchRecord, rev: number) {
    return this.t.replace(next, rev);
  }
  async list(
    f: { userId: string; role: 'founder' | 'candidate'; status?: MatchRecord['status'] },
    page: PageRequest,
  ) {
    return this.t.page(
      (m) =>
        (f.role === 'founder' ? m.founderUserId : m.candidateUserId) === f.userId &&
        (!f.status || m.status === f.status),
      page,
    );
  }
  async findActiveInvolving(userId: string, other?: string) {
    return this.t.where((m) => m.status === 'active' && involving(userId, other)(m));
  }
  async findActiveForBrief(briefId: string) {
    return this.t.where((m) => m.briefId === briefId && m.status === 'active');
  }
  async findDormantIds(cutoff: Date, limit: number) {
    return this.t
      .where((m) => m.status === 'active' && m.sprintId === null && m.startedAt <= cutoff)
      .slice(0, limit)
      .map((m) => m.id);
  }
  async existsBetween(a: string, b: string) {
    return this.t.where(involving(a, b)).length > 0;
  }
}

export class MemorySprintStore implements SprintStore, Snapshottable {
  readonly t = new Records<TrialSprintRecord>([(s) => `match:${s.matchId}`]);
  snapshot = () => this.t.snapshot();
  restore = (s: unknown) => this.t.restore(s);
  async insert(s: TrialSprintRecord) {
    return this.t.insert(s);
  }
  async findById(id: string) {
    return this.t.get(id);
  }
  async findByMatch(matchId: string) {
    return this.t.where((s) => s.matchId === matchId)[0] ?? null;
  }
  async replace(next: TrialSprintRecord, rev: number) {
    return this.t.replace(next, rev);
  }
  async findDueIds(now: Date, reviewCutoff: Date, ackCutoff: Date, limit: number) {
    return this.t
      .where(
        (s) =>
          (['proposed', 'awaiting_approval', 'active'].includes(s.status) &&
            s.terms.deadline <= now.toISOString()) ||
          (s.status === 'submitted' && !!s.submittedAt && s.submittedAt <= reviewCutoff) ||
          (s.status === 'reviewed' && !!s.reviewedAt && s.reviewedAt <= ackCutoff),
      )
      .slice(0, limit)
      .map((s) => s.id);
  }
  async countCompletedForFounder(founderUserId: string) {
    return this.t.where((s) => s.founderUserId === founderUserId && s.status === 'completed')
      .length;
  }
}

export class MemoryBlockStore implements BlockStore, Snapshottable {
  rows: BlockRecord[] = [];
  snapshot = () => c(this.rows);
  restore = (s: unknown) => {
    this.rows = s as BlockRecord[];
  };
  async insert(b: BlockRecord) {
    const found = this.rows.find(
      (x) => x.blockerUserId === b.blockerUserId && x.blockedUserId === b.blockedUserId,
    );
    if (found) return c(found);
    this.rows.push(c(b));
    return c(b);
  }
  async remove(blocker: string, blocked: string) {
    const before = this.rows.length;
    this.rows = this.rows.filter(
      (x) => !(x.blockerUserId === blocker && x.blockedUserId === blocked),
    );
    return this.rows.length < before;
  }
  async listByBlocker(blocker: string) {
    return this.rows
      .filter((x) => x.blockerUserId === blocker)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(c);
  }
  async existsEither(a: string, b: string) {
    return this.rows.some(
      (x) =>
        (x.blockerUserId === a && x.blockedUserId === b) ||
        (x.blockerUserId === b && x.blockedUserId === a),
    );
  }
  async blockedAmong(userId: string, others: readonly string[]) {
    const out = new Set<string>();
    for (const o of others) if (await this.existsEither(userId, o)) out.add(o);
    return out;
  }
}

export class MemoryGuardStore implements RelationshipGuardStore, Snapshottable {
  revisions = new Map<string, number>();
  snapshot = () => [...this.revisions.entries()];
  restore = (s: unknown) => {
    this.revisions = new Map(s as Array<[string, number]>);
  };
  async touch(a: string, b: string) {
    const { key } = guardKey(a, b);
    const n = (this.revisions.get(key) ?? 0) + 1;
    this.revisions.set(key, n);
    return n;
  }
}

export class MemorySafetyCaseStore implements SafetyCaseStore, Snapshottable {
  readonly t = new Records<SafetyCaseRecord>([]);
  snapshot = () => this.t.snapshot();
  restore = (s: unknown) => this.t.restore(s);
  async insert(r: SafetyCaseRecord) {
    return this.t.insert(r) === 'created' ? ('created' as const) : ('exists' as const);
  }
  async findById(id: string) {
    return this.t.get(id);
  }
  async replace(next: SafetyCaseRecord, rev: number) {
    return this.t.replace(next, rev);
  }
  async list(
    f: { reporterUserId?: string; status?: SafetyCaseRecord['status'] },
    page: PageRequest,
  ) {
    return this.t.page(
      (r) =>
        (!f.reporterUserId || r.reporterUserId === f.reporterUserId) &&
        (!f.status || r.status === f.status),
      page,
    );
  }
  async countByReporterSince(reporterUserId: string, since: Date) {
    return this.t.where((r) => r.reporterUserId === reporterUserId && r.createdAt >= since).length;
  }
  async findOpenDuplicate(
    reporterUserId: string,
    kind: SafetyCaseRecord['kind'],
    targetType: SafetyCaseRecord['targetType'],
    targetId: string,
  ) {
    return (
      this.t.where(
        (r) =>
          r.reporterUserId === reporterUserId &&
          r.kind === kind &&
          r.targetType === targetType &&
          r.targetId === targetId &&
          (r.status === 'open' || r.status === 'in_review'),
      )[0] ?? null
    );
  }
  async findForTarget(targetType: SafetyCaseRecord['targetType'], targetId: string) {
    return this.t
      .where((r) => r.targetType === targetType && r.targetId === targetId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async findActiveHolds() {
    return this.t.where((r) => r.hold !== null && r.hold.releasedAt === null);
  }
}

export class MemoryAuditStore implements AuditStore, Snapshottable {
  events: AuditEventRecord[] = [];
  snapshot = () => c(this.events);
  restore = (s: unknown) => {
    this.events = s as AuditEventRecord[];
  };
  async append(e: AuditEventRecord) {
    this.events.push(c(e));
  }
  async listForTarget(targetType: string, targetId: string) {
    return this.events.filter((e) => e.targetType === targetType && e.targetId === targetId).map(c);
  }
}

/**
 * Serialises transactions with a promise chain and restores every participating store when the
 * callback throws — the observable all-or-nothing behaviour of a MongoDB transaction.
 */
export class MemoryTransactionRunner implements TransactionRunner {
  readonly atomic = true;
  private chain: Promise<unknown> = Promise.resolve();
  /** Number of transactions rolled back (tests assert on it). */
  rollbacks = 0;
  constructor(private readonly stores: Snapshottable[]) {}

  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const exec = async () => {
      const snaps = this.stores.map((s) => s.snapshot());
      try {
        return await fn(NO_TX);
      } catch (err) {
        this.stores.forEach((s, i) => s.restore(snaps[i]));
        this.rollbacks += 1;
        throw err;
      }
    };
    const next = this.chain.then(exec, exec);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export function createMemoryPhase11Stores() {
  const requests = new MemoryMatchRequestStore();
  const matches = new MemoryMatchStore();
  const sprints = new MemorySprintStore();
  const blocks = new MemoryBlockStore();
  const guards = new MemoryGuardStore();
  const cases = new MemorySafetyCaseStore();
  const audit = new MemoryAuditStore();
  const tx = new MemoryTransactionRunner([
    requests,
    matches,
    sprints,
    blocks,
    guards,
    cases,
    audit,
  ]);
  return { requests, matches, sprints, blocks, guards, cases, audit, tx };
}
