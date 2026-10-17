import mongoose, { type Connection } from 'mongoose';
import type { AccountMode, AccountStatus, UserRole } from '@cofoundry/shared';
import { identityModels, type SessionDoc, type UserDoc } from './models.js';

/** Plain records used by the auth service; ids are hex strings. */
export interface UserRecord {
  id: string;
  emailLower: string;
  passwordHash: string;
  displayName: string;
  roles: UserRole[];
  cohortId: string;
  status: AccountStatus;
  accountMode: AccountMode;
  authVersion: number;
  emailVerifiedAt: Date | null;
}

export interface SessionRecord {
  id: string;
  tokenHash: string;
  userId: string | null;
  csrfTokenHash: string;
  authVersion: number;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

export type NewSession = Omit<SessionRecord, 'id'>;

/** Persistence port for identity. Every write is a single-document atomic operation. */
export interface IdentityStore {
  findUserByEmail(emailLower: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  /** Ids of active users holding `role` in a cohort (discovery scope; cohorts are small). */
  listActiveUserIdsInCohort(cohortId: string, role: UserRole): Promise<string[]>;
  /** Bulk read by id (one query); unknown ids are skipped. */
  findUsersByIds(ids: readonly string[]): Promise<UserRecord[]>;
  createSession(session: NewSession): Promise<SessionRecord>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  touchSession(id: string, lastSeenAt: Date): Promise<void>;
  /** Replaces the CSRF hash only while the session still exists. Returns false if it is gone. */
  setSessionCsrf(id: string, csrfTokenHash: string): Promise<boolean>;
  deleteSession(id: string): Promise<void>;
  deleteSessionsForUser(userId: string): Promise<number>;
  /** Deletes sessions past their absolute expiry, or signed-in sessions idle since `idleBefore`. */
  deleteExpiredSessions(now: Date, idleBefore: Date): Promise<number>;
}

function toUser(doc: UserDoc): UserRecord {
  return {
    id: doc._id.toHexString(),
    emailLower: doc.emailLower,
    passwordHash: doc.passwordHash,
    displayName: doc.displayName,
    roles: [...doc.roles],
    cohortId: doc.cohortId,
    status: doc.status,
    accountMode: doc.accountMode,
    authVersion: doc.authVersion,
    emailVerifiedAt: doc.emailVerifiedAt ?? null,
  };
}

function toSession(doc: SessionDoc): SessionRecord {
  return {
    id: doc._id.toHexString(),
    tokenHash: doc.tokenHash,
    userId: doc.userId ? doc.userId.toHexString() : null,
    csrfTokenHash: doc.csrfTokenHash,
    authVersion: doc.authVersion,
    createdAt: doc.createdAt,
    lastSeenAt: doc.lastSeenAt,
    expiresAt: doc.expiresAt,
  };
}

const isObjectId = (id: string) => /^[a-f0-9]{24}$/.test(id);

export function createMongoIdentityStore(conn: Connection): IdentityStore {
  const { User, Session } = identityModels(conn);
  return {
    async findUserByEmail(emailLower) {
      const doc = await User.findOne({ emailLower }).lean<UserDoc>().exec();
      return doc ? toUser(doc) : null;
    },
    async findUserById(id) {
      if (!isObjectId(id)) return null;
      const doc = await User.findById(id).lean<UserDoc>().exec();
      return doc ? toUser(doc) : null;
    },
    async listActiveUserIdsInCohort(cohortId, role) {
      const docs = await User.find({ cohortId, roles: role, status: 'active' }, { _id: 1 })
        .lean<Array<{ _id: mongoose.Types.ObjectId }>>()
        .exec();
      return docs.map((d) => d._id.toHexString());
    },
    async findUsersByIds(ids) {
      const valid = ids.filter(isObjectId);
      if (valid.length === 0) return [];
      const docs = await User.find({ _id: { $in: valid } })
        .lean<UserDoc[]>()
        .exec();
      return docs.map(toUser);
    },
    async createSession(session) {
      const doc = await Session.create({
        ...session,
        userId: session.userId ? new mongoose.Types.ObjectId(session.userId) : null,
      });
      return toSession(doc.toObject());
    },
    async findSessionByTokenHash(tokenHash) {
      const doc = await Session.findOne({ tokenHash }).lean<SessionDoc>().exec();
      return doc ? toSession(doc) : null;
    },
    async touchSession(id, lastSeenAt) {
      await Session.updateOne({ _id: id }, { $set: { lastSeenAt } }).exec();
    },
    async setSessionCsrf(id, csrfTokenHash) {
      const res = await Session.updateOne({ _id: id }, { $set: { csrfTokenHash } }).exec();
      return res.matchedCount === 1;
    },
    async deleteSession(id) {
      await Session.deleteOne({ _id: id }).exec();
    },
    async deleteSessionsForUser(userId) {
      if (!isObjectId(userId)) return 0;
      const res = await Session.deleteMany({ userId: new mongoose.Types.ObjectId(userId) }).exec();
      return res.deletedCount;
    },
    async deleteExpiredSessions(now, idleBefore) {
      const expired = await Session.deleteMany({ expiresAt: { $lte: now } }).exec();
      const idle = await Session.deleteMany({
        userId: { $ne: null },
        lastSeenAt: { $lt: idleBefore },
      }).exec();
      return expired.deletedCount + idle.deletedCount;
    },
  };
}
