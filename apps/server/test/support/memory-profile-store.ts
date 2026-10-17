import type {
  CandidateProfileRecord,
  ConsentKey,
  FounderProfileRecord,
  ProfileStore,
} from '../../src/profiles/store.js';

interface ConsentRow extends ConsentKey {
  policyVersion: string;
  grantedAt: Date;
  withdrawnAt: Date | null;
}

/**
 * In-memory ProfileStore with the same optimistic-concurrency semantics as the Mongo store.
 * The Mongo implementation is exercised by profiles.integration.test.ts.
 */
export class MemoryProfileStore implements ProfileStore {
  candidates = new Map<string, CandidateProfileRecord>();
  founders = new Map<string, FounderProfileRecord>();
  consents: ConsentRow[] = [];
  /** Test hook: fail the next saveCandidate call to simulate a crash between writes. */
  failNextCandidateSave = false;

  async findCandidate(userId: string) {
    const r = this.candidates.get(userId);
    return r ? structuredClone(r) : null;
  }
  async saveCandidate(
    userId: string,
    expectedRevision: number,
    fields: Omit<CandidateProfileRecord, 'userId' | 'revision' | 'updatedAt'>,
  ) {
    if (this.failNextCandidateSave) {
      this.failNextCandidateSave = false;
      throw new Error('simulated write failure');
    }
    const current = this.candidates.get(userId);
    if ((current?.revision ?? 0) !== expectedRevision) return 'conflict' as const;
    const record: CandidateProfileRecord = {
      ...structuredClone(fields),
      userId,
      revision: expectedRevision + 1,
      updatedAt: new Date(),
    };
    this.candidates.set(userId, record);
    return structuredClone(record);
  }
  async findFounder(userId: string) {
    const r = this.founders.get(userId);
    return r ? { ...r } : null;
  }
  async saveFounder(
    userId: string,
    expectedRevision: number,
    fields: { bio: string; companyUrl: string | null },
  ) {
    const current = this.founders.get(userId);
    if ((current?.revision ?? 0) !== expectedRevision) return 'conflict' as const;
    const record: FounderProfileRecord = {
      ...fields,
      userId,
      revision: expectedRevision + 1,
      updatedAt: new Date(),
    };
    this.founders.set(userId, record);
    return { ...record };
  }
  private active(key: ConsentKey) {
    return this.consents.filter(
      (c) =>
        c.userId === key.userId &&
        c.purpose === key.purpose &&
        c.targetId === key.targetId &&
        c.withdrawnAt === null,
    );
  }
  async hasActiveConsent(key: ConsentKey) {
    return this.active(key).length > 0;
  }
  async grantConsent(key: ConsentKey, policyVersion: string, at: Date) {
    if (this.active(key).length === 0) {
      this.consents.push({ ...key, policyVersion, grantedAt: at, withdrawnAt: null });
    }
  }
  async withdrawConsent(key: ConsentKey, at: Date) {
    const rows = this.active(key);
    for (const r of rows) r.withdrawnAt = at;
    return rows.length;
  }
}
