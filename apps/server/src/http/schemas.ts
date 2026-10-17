import { z } from 'zod';
import {
  SKILL_IDS,
  checkHttpsUrl,
  normalizeText,
  resolveSkillId,
  type SkillId,
} from '@cofoundry/shared';

/** Reusable route-boundary schemas (Sections 03 and 23). */

/** Plain text: NFKC-normalised and trimmed before length checks (Section 03). */
export const text = (min: number, max: number, label: string) =>
  z
    .string()
    .max(max * 4)
    .transform(normalizeText)
    .pipe(
      z
        .string()
        .min(
          min,
          min === 1 ? `${label} is required.` : `${label} needs at least ${min} characters.`,
        )
        .max(max, `${label} can be at most ${max} characters.`),
    );

/** Canonical skill id or one of the fixed aliases; other free text is rejected. */
export const skillId = z
  .string()
  .max(40)
  .transform((value, ctx): SkillId => {
    const id = resolveSkillId(value);
    if (!id) {
      ctx.addIssue({
        code: 'custom',
        message: `Unknown skill. Choose one of: ${SKILL_IDS.join(', ')}.`,
      });
      return z.NEVER;
    }
    return id;
  });

export const distinct =
  <T>(label: string) =>
  (items: T[], ctx: z.RefinementCtx) => {
    if (new Set(items).size !== items.length) {
      ctx.addIssue({ code: 'custom', message: `Remove duplicate ${label}.` });
    }
  };

const URL_MESSAGES: Record<string, string> = {
  too_long: 'Links can be at most 2,048 characters.',
  invalid: 'Enter a full link starting with https://.',
  not_https: 'Links must start with https://.',
  credentials: 'Links cannot contain a username or password.',
  fragment: 'Remove the # part of the link.',
  port: 'Links cannot use a custom port.',
  local_host: 'Use a public website address.',
  ip_literal: 'Use a website name, not an IP address.',
};

/** Section 23 URL rules; empty input means "no link". */
export const httpsUrlOrNull = z
  .string()
  .max(2048 * 2)
  .nullable()
  .transform((value, ctx) => {
    const trimmed = value?.trim() ?? '';
    if (trimmed === '') return null;
    const check = checkHttpsUrl(trimmed);
    if (!check.ok) {
      ctx.addIssue({ code: 'custom', message: URL_MESSAGES[check.reason] ?? 'Invalid link.' });
      return z.NEVER;
    }
    return check.url;
  });

/** Whole number within a range, with one message for both bounds. */
export const intRange = (min: number, max: number, unit: string) =>
  z
    .number({ error: `Enter a whole number of ${unit}.` })
    .int(`Use whole ${unit}.`)
    .min(min, `Use ${min}-${max} ${unit}.`)
    .max(max, `Use ${min}-${max} ${unit}.`);
