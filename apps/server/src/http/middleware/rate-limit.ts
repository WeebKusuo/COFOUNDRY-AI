import { ipKeyGenerator, rateLimit, type Options } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import { API_PREFIX, normalizeEmail } from '@cofoundry/shared';
import { AppError } from '../errors.js';

/**
 * Section 23 rate limits. Counters are in-process memory, which matches the contract's single
 * API/worker instance; a shared store is required before running more than one instance.
 */

export interface RateLimitOptions {
  windowMs: number;
  limit: number;
  /** Return true to exempt a request (e.g. the health endpoint). */
  skip?: Options['skip'];
  keyGenerator?: Options['keyGenerator'];
  /** Count only failed responses (status >= 400), e.g. failed sign-in attempts. */
  countFailuresOnly?: boolean;
}

function clientIpKey(req: Request): string {
  return `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
}

/** Answers with the standard error envelope, 429 RATE_LIMITED and Retry-After. */
export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: options.countFailuresOnly ?? false,
    keyGenerator: options.keyGenerator ?? clientIpKey,
    ...(options.skip ? { skip: options.skip } : {}),
    handler: (req, _res, next) => {
      const resetTime = (req as { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
      const seconds = resetTime
        ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
        : Math.ceil(options.windowMs / 1000);
      next(
        new AppError('RATE_LIMITED', 'Too many requests. Try again shortly.', {
          headers: { 'Retry-After': String(seconds) },
        }),
      );
    },
  });
}

/**
 * General limit: 120 requests per minute per session (per IP before a session exists),
 * health excluded. Runs after the session loader.
 */
export function generalApiLimiter(): RequestHandler {
  return createRateLimiter({
    windowMs: 60_000,
    limit: 120,
    // Compare the full mounted path; req.path is relative to the router mount point.
    skip: (req) => `${req.baseUrl}${req.path}` === `${API_PREFIX}/health`,
    keyGenerator: (req) =>
      req.auth?.session ? `session:${req.auth.session.id}` : clientIpKey(req),
  });
}

const FIFTEEN_MINUTES = 15 * 60_000;

/** Login: 5 failed attempts per normalised account per 15 minutes (generic error). */
export function loginAccountLimiter(): RequestHandler {
  return createRateLimiter({
    windowMs: FIFTEEN_MINUTES,
    limit: 5,
    countFailuresOnly: true,
    keyGenerator: (req) => {
      const email = (req.body as { email?: unknown } | undefined)?.email;
      return `acct:${typeof email === 'string' ? normalizeEmail(email).slice(0, 254) : '-'}`;
    },
  });
}

/** Login: 20 failed attempts per client IP per 15 minutes, independent of the account limit. */
export function loginIpLimiter(): RequestHandler {
  return createRateLimiter({ windowMs: FIFTEEN_MINUTES, limit: 20, countFailuresOnly: true });
}

/** CSRF bootstrap creates sessions, so it is limited separately (30/min per IP). */
export function csrfBootstrapLimiter(): RequestHandler {
  return createRateLimiter({ windowMs: 60_000, limit: 30 });
}

export interface AuthRateLimiters {
  general: RequestHandler;
  loginAccount: RequestHandler;
  loginIp: RequestHandler;
  csrf: RequestHandler;
}

export function defaultAuthRateLimiters(): AuthRateLimiters {
  return {
    general: generalApiLimiter(),
    loginAccount: loginAccountLimiter(),
    loginIp: loginIpLimiter(),
    csrf: csrfBootstrapLimiter(),
  };
}
