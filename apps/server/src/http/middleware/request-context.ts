import { randomBytes, randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * Assigns a server-generated requestId to every request (Section 17: all responses include it).
 * Client-supplied IDs are never trusted, so log correlation cannot be spoofed.
 */
export const requestContext: RequestHandler = (_req, res, next) => {
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  // Per-response CSP nonce for style elements created by our own bundled code (Monaco editor);
  // scripts stay 'self'-only. Injected into the SPA shell by static-web.ts.
  res.locals.cspNonce = randomBytes(16).toString('base64');
  res.setHeader('X-Request-Id', requestId);
  next();
};

/** API responses are user-specific and must never be cached by browsers or proxies. */
export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};
