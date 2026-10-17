import { SKILL_ALIASES, SKILL_IDS, type SkillId } from './constants.js';

/**
 * Section 03: text is trimmed, Unicode-normalised (NFKC) and stored as plain text.
 * Never render the result as HTML.
 */
export function normalizeText(input: string): string {
  return input.normalize('NFKC').trim();
}

/** Length measured in user-perceived code points after normalisation. */
export function textLength(input: string): number {
  return Array.from(input).length;
}

/**
 * Resolve a skill identifier or one of the fixed aliases. Returns null for anything else —
 * free text is rejected with the allowed choices, never AI-normalised (Section 03).
 */
export function resolveSkillId(input: string): SkillId | null {
  const key = normalizeText(input).toLowerCase();
  if ((SKILL_IDS as readonly string[]).includes(key)) return key as SkillId;
  return SKILL_ALIASES[key] ?? null;
}
