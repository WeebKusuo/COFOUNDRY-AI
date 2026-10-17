import { pino, type Logger } from 'pino';
import type { LogLevel } from '../config/env.js';

/**
 * Structured JSON logging (Section 25). Never log credentials, cookies, CSRF values, answer
 * text, prompts or full URLs with query strings. Redaction is a safety net, not permission to
 * pass sensitive data to the logger.
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.apiKey',
  '*.token',
  '*.csrfToken',
  '*.mongodbUri',
];

export function createLogger(level: LogLevel, base: Record<string, unknown> = {}): Logger {
  return pino({
    level,
    base: { service: 'cofoundry-server', ...base },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type { Logger };
