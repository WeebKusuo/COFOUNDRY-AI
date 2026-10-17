import helmet from 'helmet';
import type { RequestHandler } from 'express';
import { AppError } from '../errors.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isMutation(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/**
 * Strict security headers (Section 23): scripts/styles only from our own build, no unsafe-eval,
 * browser connections same-origin only, no framing.
 */
export function securityHeaders(options: { hsts: boolean }): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        ...(options.hsts ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: options.hsts ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
}

/**
 * Origin check for every browser mutation (Section 22): the Origin header must be present and
 * equal APP_ORIGIN exactly. The CSRF synchronizer token is added with sessions in Phase 2;
 * this guard is the first layer and never replaces it.
 */
export function requireSameOrigin(appOrigin: string): RequestHandler {
  return (req, _res, next) => {
    if (!isMutation(req.method)) return next();
    const origin = req.get('origin');
    if (!origin || origin !== appOrigin) {
      return next(new AppError('CSRF_INVALID', 'The request origin is not allowed.'));
    }
    next();
  };
}

/**
 * JSON only (Sections 17 and 23). Any request that carries a body must declare
 * application/json; multipart and other upload formats are always rejected.
 */
export const requireJsonBody: RequestHandler = (req, _res, next) => {
  const contentType = (req.get('content-type') ?? '').toLowerCase();
  if (contentType.startsWith('multipart/')) {
    return next(new AppError('BAD_REQUEST', 'File uploads are not supported.'));
  }
  const length = req.get('content-length');
  const hasBody =
    (length !== undefined && length !== '0') || req.get('transfer-encoding') !== undefined;
  if (hasBody && !/^application\/json(\s*;|$)/.test(contentType)) {
    return next(new AppError('BAD_REQUEST', 'Request bodies must be JSON (application/json).'));
  }
  next();
};
