import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { UserRole } from '@cofoundry/shared';
import { CSRF_HEADER } from '@cofoundry/shared';
import { matchesHash } from '../../auth/crypto.js';
import { clearSessionCookie, readCookie, type CookieSettings } from '../../auth/cookies.js';
import type { AuthService, ResolvedSession } from '../../auth/service.js';
import type { UserRecord } from '../../auth/store.js';
import { AppError } from '../errors.js';
import { isMutation } from './security.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Resolved session for this request (anonymous bootstrap or signed in), if any. */
    auth?: ResolvedSession | null;
  }
}

/**
 * Resolves the session cookie once per request. Invalid, expired, idle, stale-authVersion or
 * suspended sessions are deleted and the cookie is cleared, so the client sees a clean 401.
 */
export function loadSession(auth: AuthService, cookies: CookieSettings): RequestHandler {
  return async (req, res, next) => {
    const token = readCookie(req, cookies.name);
    if (!token) {
      req.auth = null;
      return next();
    }
    const resolved = await auth.resolve(token);
    req.auth = resolved;
    if (!resolved) clearSessionCookie(res, cookies);
    next();
  };
}

/**
 * Synchronizer-token CSRF check (Section 22) for every mutation, including login and logout.
 * The token must match the hash stored on the caller's own session; comparison is constant-time.
 * Runs after the exact-Origin guard.
 */
export const requireCsrf: RequestHandler = (req, _res, next) => {
  if (!isMutation(req.method)) return next();
  const presented = req.get(CSRF_HEADER);
  const session = req.auth?.session;
  if (!session || !presented || presented.length > 128) {
    return next(new AppError('CSRF_INVALID', 'Your security token is missing or expired.'));
  }
  if (!matchesHash(presented, session.csrfTokenHash)) {
    return next(new AppError('CSRF_INVALID', 'Your security token is missing or expired.'));
  }
  next();
};

/**
 * Deny by default (Section 17): every route requires a signed-in session except the explicitly
 * public ones. New routes are protected unless someone deliberately adds them here.
 */
export function requireSignedInExcept(publicRoutes: ReadonlyArray<string>): RequestHandler {
  const allow = new Set(publicRoutes);
  return (req, _res, next) => {
    if (allow.has(`${req.method} ${req.path}`)) return next();
    if (!req.auth?.user) return next(new AppError('UNAUTHENTICATED', 'Sign in to continue.'));
    next();
  };
}

/** The signed-in user. Only valid after requireSignedInExcept has run for this route. */
export function currentUser(req: Request): UserRecord {
  const user = req.auth?.user;
  if (!user) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
  return user;
}

/** Server-side RBAC: the user must hold at least one of the roles. */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = req.auth?.user;
    if (!user) return next(new AppError('UNAUTHENTICATED', 'Sign in to continue.'));
    if (!roles.some((r) => user.roles.includes(r))) {
      return next(new AppError('FORBIDDEN', 'Your account does not have access to this area.'));
    }
    next();
  };
}

/**
 * Ownership rule (Section 17): a resource the caller is unrelated to is reported as NOT_FOUND,
 * so its existence is never confirmed. Use `assertAllowed` for owned-but-disallowed actions (403).
 */
export function assertOwnedBy(ownerUserId: string | null | undefined, user: UserRecord): void {
  if (!ownerUserId || ownerUserId !== user.id) {
    throw new AppError('NOT_FOUND', 'The requested resource was not found.');
  }
}

export function assertAllowed(allowed: boolean, message = 'This action is not allowed.'): void {
  if (!allowed) throw new AppError('FORBIDDEN', message);
}
