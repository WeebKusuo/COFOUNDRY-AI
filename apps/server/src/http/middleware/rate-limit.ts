import { rateLimit, type Options } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { API_PREFIX } from '@cofoundry/shared';
import { AppError } from '../errors.js';

export interface RateLimitOptions {
  windowMs: number;
  limit: number;
  /** Return true to exempt a request (e.g. the health endpoint). */
  skip?: Options['skip'];
}

/**
 * Rate limiter that answers with the standard error envelope, 429 RATE_LIMITED and Retry-After
 * (Section 23). Phase 1 keys by client IP (honouring only the configured trusted proxy hops);
 * Phase 2 switches the general limiter to per-session keys once sessions exist.
 */
export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
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

/** Section 23 default: 120 requests per minute, health excluded. */
export function generalApiLimiter(): RequestHandler {
  return createRateLimiter({
    windowMs: 60_000,
    limit: 120,
    // Compare the full mounted path; req.path is relative to the router mount point.
    skip: (req) => `${req.baseUrl}${req.path}` === `${API_PREFIX}/health`,
  });
}
