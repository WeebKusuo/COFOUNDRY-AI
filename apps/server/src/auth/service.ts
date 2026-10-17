import { SESSION, normalizeEmail, type SessionUser } from '@cofoundry/shared';
import { burnPasswordCheck, randomToken, sha256, verifyPassword } from './crypto.js';
import type { IdentityStore, SessionRecord, UserRecord } from './store.js';

/**
 * Session and login rules (Section 22):
 *  - random opaque 32-byte token in the cookie, only its SHA-256 stored;
 *  - absolute lifetime SESSION_TTL_SECONDS (max 8 h), idle expiry 30 min checked on every request;
 *  - anonymous CSRF bootstrap sessions last 15 min;
 *  - login rotates both the session and the CSRF token;
 *  - a session is valid only while the account is active and its authVersion still matches.
 */

export interface ResolvedSession {
  session: SessionRecord;
  /** Null for the anonymous bootstrap session. */
  user: UserRecord | null;
}

export interface AuthServiceOptions {
  sessionTtlSeconds: number;
  idleSeconds?: number;
  anonymousSeconds?: number;
  /** lastSeenAt is written at most this often, so reads do not all become writes. */
  touchIntervalSeconds?: number;
  now?: () => Date;
}

export interface IssuedSession {
  /** Raw cookie token — set it on the response and never store it. */
  token: string;
  session: SessionRecord;
  maxAgeSeconds: number;
}

export function toSessionUser(user: UserRecord): SessionUser {
  return {
    id: user.id,
    email: user.emailLower,
    displayName: user.displayName,
    roles: [...user.roles],
    accountMode: user.accountMode,
    emailVerifiedAt: user.emailVerifiedAt ? user.emailVerifiedAt.toISOString() : null,
  };
}

export class AuthService {
  readonly sessionTtlSeconds: number;
  readonly idleSeconds: number;
  readonly anonymousSeconds: number;
  private readonly touchIntervalMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: IdentityStore,
    options: AuthServiceOptions,
  ) {
    this.sessionTtlSeconds = Math.min(options.sessionTtlSeconds, SESSION.absoluteSeconds);
    this.idleSeconds = options.idleSeconds ?? SESSION.idleSeconds;
    this.anonymousSeconds = options.anonymousSeconds ?? SESSION.csrfBootstrapSeconds;
    this.touchIntervalMs = (options.touchIntervalSeconds ?? 30) * 1000;
    this.now = options.now ?? (() => new Date());
  }

  /** Returns the live session for a cookie token, deleting it if it is expired or stale. */
  async resolve(token: string | undefined): Promise<ResolvedSession | null> {
    if (!token || token.length > 128) return null;
    const session = await this.store.findSessionByTokenHash(sha256(token));
    if (!session) return null;
    const now = this.now();

    if (session.expiresAt.getTime() <= now.getTime()) {
      await this.store.deleteSession(session.id);
      return null;
    }
    if (!session.userId) return { session, user: null };

    if (now.getTime() - session.lastSeenAt.getTime() > this.idleSeconds * 1000) {
      await this.store.deleteSession(session.id);
      return null;
    }
    const user = await this.store.findUserById(session.userId);
    if (!user || user.status !== 'active' || user.authVersion !== session.authVersion) {
      await this.store.deleteSession(session.id);
      return null;
    }
    if (now.getTime() - session.lastSeenAt.getTime() >= this.touchIntervalMs) {
      await this.store.touchSession(session.id, now);
      session.lastSeenAt = now;
    }
    return { session, user };
  }

  /** Creates the 15-minute anonymous bootstrap session used before sign-in. */
  async createAnonymousSession(): Promise<IssuedSession> {
    const now = this.now();
    const token = randomToken();
    const session = await this.store.createSession({
      tokenHash: sha256(token),
      userId: null,
      csrfTokenHash: sha256(randomToken()),
      authVersion: 0,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + this.anonymousSeconds * 1000),
    });
    return { token, session, maxAgeSeconds: this.anonymousSeconds };
  }

  /**
   * Issues a fresh CSRF token for the session and stores only its hash. Each call replaces the
   * previous token; clients refetch once if a stale token is rejected.
   */
  async issueCsrfToken(session: SessionRecord): Promise<string | null> {
    const csrfToken = randomToken();
    const ok = await this.store.setSessionCsrf(session.id, sha256(csrfToken));
    return ok ? csrfToken : null;
  }

  /**
   * Verifies credentials with a uniform failure path (no account enumeration) and rotates the
   * session: a new token and CSRF secret are issued and the previous session is deleted.
   */
  async login(
    current: SessionRecord | null,
    email: string,
    password: string,
  ): Promise<{ issued: IssuedSession; user: UserRecord } | null> {
    const user = await this.store.findUserByEmail(normalizeEmail(email));
    if (!user) {
      await burnPasswordCheck(password);
      return null;
    }
    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid || user.status !== 'active') return null;

    const now = this.now();
    const token = randomToken();
    const session = await this.store.createSession({
      tokenHash: sha256(token),
      userId: user.id,
      csrfTokenHash: sha256(randomToken()),
      authVersion: user.authVersion,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + this.sessionTtlSeconds * 1000),
    });
    if (current) await this.store.deleteSession(current.id);
    return { issued: { token, session, maxAgeSeconds: this.sessionTtlSeconds }, user };
  }

  async logout(session: SessionRecord): Promise<void> {
    await this.store.deleteSession(session.id);
  }

  /** Sweeper for expired and idle sessions; validity is still checked on every request. */
  async purgeExpiredSessions(): Promise<number> {
    const now = this.now();
    return this.store.deleteExpiredSessions(now, new Date(now.getTime() - this.idleSeconds * 1000));
  }

  /** Revokes every session of a user (used by suspension and deletion in later phases). */
  async revokeAllSessions(userId: string): Promise<number> {
    return this.store.deleteSessionsForUser(userId);
  }
}
