import mongoose, { type Connection, type Model, type Types } from 'mongoose';
import { ACCOUNT_MODES, ACCOUNT_STATUSES, USER_ROLES } from '@cofoundry/shared';
import type { AccountMode, AccountStatus, UserRole } from '@cofoundry/shared';

/**
 * Section 14 persistence for identity. Indexes are created by migration 2 (src/db/migrations.ts),
 * never implicitly. Server-owned fields are never written from request bodies.
 */

export interface UserDoc {
  _id: Types.ObjectId;
  emailLower: string;
  passwordHash: string;
  displayName: string;
  roles: UserRole[];
  cohortId: string;
  status: AccountStatus;
  accountMode: AccountMode;
  /** Incremented to invalidate every session of the user (logout-all, suspension, deletion). */
  authVersion: number;
  emailVerifiedAt: Date | null;
  /** Stable key for idempotent demo seeding; absent for operator-provisioned pilot users. */
  seedKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionDoc {
  _id: Types.ObjectId;
  /** SHA-256 of the cookie token. The raw token is never stored. */
  tokenHash: string;
  /** Null for the 15-minute anonymous CSRF bootstrap session. */
  userId: Types.ObjectId | null;
  csrfTokenHash: string;
  authVersion: number;
  createdAt: Date;
  lastSeenAt: Date;
  /** Absolute expiry; idle expiry is checked against lastSeenAt on every request. */
  expiresAt: Date;
  updatedAt: Date;
}

const userSchema = new mongoose.Schema<UserDoc>(
  {
    emailLower: { type: String, required: true },
    passwordHash: { type: String, required: true },
    displayName: { type: String, required: true, minlength: 1, maxlength: 80 },
    roles: {
      type: [{ type: String, enum: USER_ROLES }],
      required: true,
      validate: (v: unknown[]) => v.length > 0,
    },
    cohortId: { type: String, required: true },
    status: { type: String, enum: ACCOUNT_STATUSES, required: true, default: 'active' },
    accountMode: { type: String, enum: ACCOUNT_MODES, required: true },
    authVersion: { type: Number, required: true, default: 1 },
    emailVerifiedAt: { type: Date, default: null },
    seedKey: { type: String },
  },
  { collection: 'users', timestamps: true, strict: 'throw', versionKey: false },
);

const sessionSchema = new mongoose.Schema<SessionDoc>(
  {
    tokenHash: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, default: null },
    csrfTokenHash: { type: String, required: true },
    authVersion: { type: Number, required: true },
    lastSeenAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'sessions', timestamps: true, strict: 'throw', versionKey: false },
);

export interface IdentityModels {
  User: Model<UserDoc>;
  Session: Model<SessionDoc>;
}

export function identityModels(conn: Connection): IdentityModels {
  return {
    User:
      (conn.models.User as Model<UserDoc> | undefined) ?? conn.model<UserDoc>('User', userSchema),
    Session:
      (conn.models.Session as Model<SessionDoc> | undefined) ??
      conn.model<SessionDoc>('Session', sessionSchema),
  };
}
