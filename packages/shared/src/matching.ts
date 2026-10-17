import { VERSIONS, type IndustryTag, type MissionTag, type SkillId } from './constants.js';
import type { CandidateProject, SkillEntry } from './profile.js';

/**
 * Deterministic matching contracts, algorithm match-v3.0 (Sections 04, 05, 15, 19).
 *
 * Scores rank self-reported profile data against a brief. A recommendation is not a probability,
 * a project tag is not verified evidence, and no AI or semantic inference is involved.
 */

export const MATCH_ALGORITHM_VERSION = VERSIONS.algorithm;

/** Section 04 business gates, in a fixed display order. */
export const GATE_CODES = [
  'opportunity_type',
  'essential_skill',
  'minimum_hours',
  'minimum_commitment',
] as const;
export type GateCode = (typeof GATE_CODES)[number];

export const MATCH_WEIGHTS = { S: 0.4, A: 0.25, I: 0.15, P: 0.2 } as const;
/** Section 05: weight available without project evidence. */
export const PROVISIONAL_COVERAGE = 0.8;
/** The weights used without project evidence: MATCH_WEIGHTS / 0.80, exactly. */
export const PROVISIONAL_WEIGHTS = { S: 0.5, A: 0.3125, I: 0.1875, P: null } as const;
export const MATCH_SCORE_THRESHOLD = 50;
export const MATCH_GROUP_LIMIT = 3;
/** Section 06: a stored batch is usable for 15 minutes. */
export const RECOMMENDATION_TTL_MS = 15 * 60_000;
/** Section 15: personal entry contents are removed after 24 hours. */
export const RECOMMENDATION_ENTRY_RETENTION_MS = 24 * 60 * 60_000;
/** Section 23: discovery searches per founder per minute, and the cohort pool cap. */
export const DISCOVERY_SEARCHES_PER_MINUTE = 10;
export const DISCOVERY_POOL_MAX = 1000;

export const MATCH_GROUPS = ['recommendations', 'provisional', 'nearMatches'] as const;
export type MatchGroup = (typeof MATCH_GROUPS)[number];

export interface MatchComponents {
  /** Weighted skill-gap coverage, 0-100. */
  S: number;
  /** Availability, 0-100 (surplus time earns nothing). */
  A: number;
  /** Interest overlap, 0-100. */
  I: number;
  /** Best project's weighted gap coverage, 0-100; null when no projects were supplied. */
  P: number | null;
}

/** Factor weights actually applied (renormalised by 0.80 when P is missing). */
export interface MatchWeights {
  S: number;
  A: number;
  I: number;
  P: number | null;
}

export interface NearMatchDeficit {
  factor: 'hours' | 'months';
  required: number;
  offered: number;
}

/** Per-skill explanation of S (gap skills only contribute). */
export interface SkillMatchDetail {
  skillId: SkillId;
  requiredLevel: number;
  teamLevel: number;
  gap: number;
  importance: number;
  mandatory: boolean;
  /** 0 when the candidate does not list the skill (Section 03: unknown skill = level 0). */
  candidateLevel: number;
  fit: number;
  /** Share of the S denominator, 0-1 (importance × gap / Σ importance × gap). */
  weightShare: number;
}

export interface ProjectRelevance {
  projectId: string;
  title: string;
  /** P for this project, 0-100. */
  score: number;
  /** Gap skills the project is tagged with (self-reported tags only). */
  matchedGapSkills: SkillId[];
}

/** One scored candidate as stored in a RecommendationBatch (Section 15). */
export interface RecommendationEntry {
  candidateUserId: string;
  profileRevision: number;
  group: MatchGroup;
  /** Unrounded score; display with two decimals. */
  score: number;
  components: MatchComponents;
  weights: MatchWeights;
  coverageWeight: 1 | 0.8;
  provisional: boolean;
  missingFactors: Array<'projectRelevance'>;
  nearMatchDeficits: NearMatchDeficit[];
  /** Deterministic template sentences: top three positive contributions, then every deficit. */
  reasons: string[];
  skills: SkillMatchDetail[];
  projects: ProjectRelevance[];
  bestProjectId: string | null;
}

export interface GateCount {
  code: GateCode;
  count: number;
}

export interface MatchExclusions {
  /** Gate-failing candidates; one candidate may fail several gates. */
  totalExcluded: number;
  gates: GateCount[];
}

/** Privacy-safe profile shown with an entry (ProfilePublic candidate fields only). */
export interface RecommendationProfile {
  displayName: string;
  demoAccount: boolean;
  headline: string;
  bio: string;
  skills: SkillEntry[];
  industryTags: IndustryTag[];
  missionTags: MissionTag[];
  availableHoursPerWeek: number | null;
  commitmentMonths: number | null;
  projects: CandidateProject[];
}

export interface RecommendationEntryView extends RecommendationEntry {
  profile: RecommendationProfile;
}

/** POST/GET /startups/:id/recommendations (Section 17 search response). */
export interface RecommendationSearchResponse {
  batchId: string;
  briefId: string;
  briefVersion: number;
  generatedAt: string;
  expiresAt: string;
  algorithmVersion: typeof MATCH_ALGORITHM_VERSION;
  recommendations: RecommendationEntryView[];
  provisional: RecommendationEntryView[];
  nearMatches: RecommendationEntryView[];
  /** Gate counts from the search; candidates who later became invisible are never reported. */
  exclusions: MatchExclusions;
}

export const GATE_LABELS: Readonly<Record<GateCode, string>> = {
  opportunity_type: 'Not open to contributor roles',
  essential_skill: 'Below a mandatory skill level',
  minimum_hours: 'Fewer weekly hours than required',
  minimum_commitment: 'Shorter commitment than required',
};

/** Two decimals for display only; ranking and thresholds always use the unrounded score. */
export function formatMatchScore(score: number): string {
  return (Math.round(score * 100) / 100).toFixed(2);
}

export const MATCH_LIMITATION_NOTICE =
  'Scores compare self-reported profile data with your brief. They are not a probability of ' +
  'success, and project tags are not verified.';
