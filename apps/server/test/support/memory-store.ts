import { randomBytes } from 'node:crypto';
import type { IdentityStore, SessionRecord, UserRecord } from '../../src/auth/store.js';
import type { UserRole } from '@cofoundry/shared';

/**
 * In-memory IdentityStore for fast middleware tests. Behaviour that depends on MongoDB itself
 * (indexes, TTL, the real driver) is covered by the *.integration tests against a database.
 */
export class MemoryIdentityStore implements IdentityStore {
  users = new Map<string, UserRecord>();
  sessions = new Map<string, SessionRecord>();

  addUser(user: Omit<UserRecord, 'id'> & { id?: string }): UserRecord {
    const record: UserRecord = { ...user, id: user.id ?? randomBytes(12).toString('hex') };
    this.users.set(record.id, record);
    return record;
  }

  async findUserByEmail(emailLower: string) {
    return [...this.users.values()].find((u) => u.emailLower === emailLower) ?? null;
  }
  async findUserById(id: string) {
    return this.users.get(id) ?? null;
  }
  async listActiveUserIdsInCohort(cohortId: string, role: UserRole) {
    return [...this.users.values()]
      .filter((u) => u.cohortId === cohortId && u.status === 'active' && u.roles.includes(role))
      .map((u) => u.id);
  }
  async createSession(session: Omit<SessionRecord, 'id'>) {
    if ([...this.sessions.values()].some((s) => s.tokenHash === session.tokenHash)) {
      throw new Error('duplicate tokenHash');
    }
    const record = { ...session, id: randomBytes(12).toString('hex') };
    this.sessions.set(record.id, record);
    return { ...record };
  }
  async findSessionByTokenHash(tokenHash: string) {
    const found = [...this.sessions.values()].find((s) => s.tokenHash === tokenHash);
    return found ? { ...found } : null;
  }
  async touchSession(id: string, lastSeenAt: Date) {
    const s = this.sessions.get(id);
    if (s) s.lastSeenAt = lastSeenAt;
  }
  async setSessionCsrf(id: string, csrfTokenHash: string) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.csrfTokenHash = csrfTokenHash;
    return true;
  }
  async deleteSession(id: string) {
    this.sessions.delete(id);
  }
  async deleteSessionsForUser(userId: string) {
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (s.userId === userId) {
        this.sessions.delete(id);
        n += 1;
      }
    }
    return n;
  }
  async deleteExpiredSessions(now: Date, idleBefore: Date) {
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (s.expiresAt <= now || (s.userId !== null && s.lastSeenAt < idleBefore)) {
        this.sessions.delete(id);
        n += 1;
      }
    }
    return n;
  }
}
