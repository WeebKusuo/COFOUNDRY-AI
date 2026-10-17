/**
 * Fixed product constants from Implementation Contract v3.0.
 * Changing any of these requires a versioned decision record (Section 30, change control).
 */

export const CONTRACT_VERSION = 'v3.0' as const;
export const API_PREFIX = '/api/v1' as const;

/** Section 01: the only role family and opportunity offered in the MVP. */
export const ROLE_KEY = 'backend-node-v1' as const;
export const OPPORTUNITY_TYPE = 'contributor' as const;
export const WORK_MODE = 'remote' as const;

export const USER_ROLES = ['founder', 'candidate', 'moderator'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Section 03: canonical skill IDs. */
export const SKILL_IDS = [
  'nodejs',
  'javascript',
  'typescript',
  'rest-api',
  'authentication',
  'mongodb',
  'sql',
  'testing',
  'debugging',
  'docker',
  'git',
  'system-design',
] as const;
export type SkillId = (typeof SKILL_IDS)[number];

/** Section 03: the only accepted case-insensitive aliases. Anything else is rejected. */
export const SKILL_ALIASES: Readonly<Record<string, SkillId>> = Object.freeze({
  node: 'nodejs',
  'node.js': 'nodejs',
  js: 'javascript',
  ts: 'typescript',
  rest: 'rest-api',
  'rest api': 'rest-api',
  auth: 'authentication',
  mongo: 'mongodb',
});

export const INDUSTRY_TAGS = [
  'fintech',
  'education',
  'health',
  'commerce',
  'climate',
  'productivity',
  'developer-tools',
  'other',
] as const;
export type IndustryTag = (typeof INDUSTRY_TAGS)[number];

export const MISSION_TAGS = [
  'access',
  'affordability',
  'privacy',
  'sustainability',
  'automation',
  'reliability',
] as const;
export type MissionTag = (typeof MISSION_TAGS)[number];

/** Version identifiers recorded on stored artefacts (Sections 04, 06, 08, 13). */
export const VERSIONS = {
  algorithm: 'match-v3.0',
  anchors: 'backend-anchors-v3.0',
  rubric: 'rubric-v3.0',
  confidentialityNotice: 'conf-v3.0',
  assessmentPolicy: 'assessment-v3.0',
  ipPolicy: 'creator-owned-v3.0',
} as const;

/** Section 03: money is integer minor units, INR only. */
export const CURRENCY = 'INR' as const;

/** Section 23: request/input limits. */
export const LIMITS = {
  jsonBodyBytes: 128 * 1024,
  urlMaxChars: 2048,
  pageDefault: 20,
  pageMax: 50,
} as const;

/** Section 22: session lifetimes. */
export const SESSION = {
  absoluteSeconds: 28_800,
  idleSeconds: 1_800,
  csrfBootstrapSeconds: 900,
} as const;
