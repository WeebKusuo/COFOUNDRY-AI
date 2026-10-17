import { z } from 'zod';
import { LIMITS } from '@cofoundry/shared';
import type { PagePosition } from '../briefs/store.js';
import { AppError } from './errors.js';

/**
 * Section 17 pagination: opaque cursor ordered by createdAt then _id (newest first), default 20,
 * max 50. The cursor encodes only a position, never filters or user data.
 */
export const pageQuery = {
  cursor: z.string().max(200).optional(),
  limit: z.coerce
    .number()
    .int('Use a whole number.')
    .min(1)
    .max(LIMITS.pageMax, `Use at most ${LIMITS.pageMax}.`)
    .optional(),
};

export function encodeCursor(position: PagePosition | null): string | null {
  if (!position) return null;
  return Buffer.from(JSON.stringify([position.createdAt.toISOString(), position.id])).toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string | undefined): PagePosition | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      /^[a-f0-9]{24}$/.test(parsed[1])
    ) {
      const createdAt = new Date(parsed[0]);
      if (!Number.isNaN(createdAt.getTime())) return { createdAt, id: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw new AppError('VALIDATION_FAILED', 'Some fields are invalid.', {
    fieldErrors: { 'query.cursor': ['Invalid cursor.'] },
  });
}

export function pageRequest(query: { cursor?: string | undefined; limit?: number | undefined }) {
  return { after: decodeCursor(query.cursor), limit: query.limit ?? LIMITS.pageDefault };
}
