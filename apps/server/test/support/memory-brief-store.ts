import { randomBytes } from 'node:crypto';
import type {
  BriefRecord,
  BriefStore,
  IdempotencyRecord,
  IdempotencyStore,
  NewDraft,
  PageRequest,
} from '../../src/briefs/store.js';

const clone = <T>(v: T): T => structuredClone(v);

/** Newest first by createdAt, then id (same order as the Mongo store). */
function page(records: BriefRecord[], req: PageRequest): BriefRecord[] {
  const sorted = [...records].sort((a, b) =>
    b.createdAt.getTime() !== a.createdAt.getTime()
      ? b.createdAt.getTime() - a.createdAt.getTime()
      : b.id < a.id
        ? -1
        : b.id > a.id
          ? 1
          : 0,
  );
  const after = req.after;
  const filtered = after
    ? sorted.filter(
        (r) =>
          r.createdAt.getTime() < after.createdAt.getTime() ||
          (r.createdAt.getTime() === after.createdAt.getTime() && r.id < after.id),
      )
    : sorted;
  return filtered.slice(0, req.limit + 1).map(clone);
}

/** In-memory BriefStore with the same conditional-write semantics as the Mongo store. */
export class MemoryBriefStore implements BriefStore {
  records = new Map<string, BriefRecord>();
  private tick = 0;

  /** Monotonic timestamps keep list order deterministic in fast tests. */
  private stamp(): Date {
    this.tick += 1;
    return new Date(Date.UTC(2026, 9, 17, 0, 0, 0, this.tick));
  }

  static newId(): string {
    return randomBytes(12).toString('hex');
  }

  async insertDraft(draft: NewDraft) {
    const existing = this.records.get(draft.id);
    if (existing) return { record: clone(existing), created: false };
    const at = this.stamp();
    const record: BriefRecord = {
      id: draft.id,
      founderUserId: draft.founderUserId,
      status: 'draft',
      version: 0,
      transitionRevision: 0,
      ...clone(draft.fields),
      publishedAt: null,
      closedAt: null,
      closeReason: null,
      clonedFromId: draft.clonedFromId,
      createdAt: at,
      updatedAt: at,
    };
    this.records.set(record.id, record);
    return { record: clone(record), created: true };
  }

  async findById(id: string) {
    const r = this.records.get(id);
    return r ? clone(r) : null;
  }

  async listByFounder(founderUserId: string, req: PageRequest) {
    return page(
      [...this.records.values()].filter((r) => r.founderUserId === founderUserId),
      req,
    );
  }

  async listOpenByFounders(founderUserIds: string[], req: PageRequest) {
    const ids = new Set(founderUserIds);
    return page(
      [...this.records.values()].filter((r) => r.status === 'open' && ids.has(r.founderUserId)),
      req,
    );
  }

  private match(
    id: string,
    founderUserId: string,
    status: BriefRecord['status'],
    version?: number,
  ) {
    const r = this.records.get(id);
    if (!r || r.founderUserId !== founderUserId || r.status !== status) return null;
    if (version !== undefined && r.version !== version) return null;
    return r;
  }

  async updateDraft(id: string, founderUserId: string, expectedVersion: number, changes: object) {
    const r = this.match(id, founderUserId, 'draft', expectedVersion);
    if (!r) return null;
    Object.assign(r, clone(changes), { version: r.version + 1, updatedAt: this.stamp() });
    return clone(r);
  }

  async publish(
    id: string,
    founderUserId: string,
    expectedVersion: number,
    normalized: Pick<BriefRecord, 'compensation'>,
    at: Date,
  ) {
    const r = this.match(id, founderUserId, 'draft', expectedVersion);
    if (!r) return null;
    Object.assign(r, clone(normalized), {
      status: 'open',
      version: 1,
      publishedAt: at,
      transitionRevision: r.transitionRevision + 1,
      updatedAt: this.stamp(),
    });
    return clone(r);
  }

  async close(id: string, founderUserId: string, reason: string, at: Date) {
    const r = this.match(id, founderUserId, 'open');
    if (!r) return null;
    Object.assign(r, {
      status: 'closed',
      closedAt: at,
      closeReason: reason,
      transitionRevision: r.transitionRevision + 1,
      updatedAt: this.stamp(),
    });
    return clone(r);
  }
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  records = new Map<string, IdempotencyRecord>();
  private k = (actor: string, route: string, key: string) => `${actor}|${route}|${key}`;

  async reserve(record: IdempotencyRecord) {
    const key = this.k(record.actorUserId, record.route, record.key);
    const existing = this.records.get(key);
    if (existing) return { reserved: false as const, existing: clone(existing) };
    this.records.set(key, clone(record));
    return { reserved: true as const };
  }

  async complete(actorUserId: string, route: string, key: string, responseStatus: number) {
    const r = this.records.get(this.k(actorUserId, route, key));
    if (r) r.responseStatus = responseStatus;
  }

  async release(actorUserId: string, route: string, key: string) {
    this.records.delete(this.k(actorUserId, route, key));
  }

  async purgeExpired(now: Date) {
    let removed = 0;
    for (const [k, r] of this.records) {
      if (r.expiresAt <= now) {
        this.records.delete(k);
        removed += 1;
      }
    }
    return removed;
  }
}
