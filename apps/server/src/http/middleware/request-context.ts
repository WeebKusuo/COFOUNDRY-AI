import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * Assigns a server-generated requestId to every request (Section 17: all responses include it).
 * Client-supplied IDs are never trusted, so log correlation cannot be spoofed.
 */
export const requestContext: RequestHandler = (_req, res, next) => {
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
};

/** API responses are user-specific and must never be cached by browsers or proxies. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};
