import {
  GATE_CODES,
  MATCH_GROUP_LIMIT,
  MATCH_SCORE_THRESHOLD,
  MATCH_WEIGHTS,
  PROVISIONAL_COVERAGE,
  PROVISIONAL_WEIGHTS,
  SKILL_LABELS,
  type GateCode,
  type IndustryTag,
  type MatchComponents,
  type MatchExclusions,
  type MatchGroup,
  type MatchWeights,
  type MissionTag,
  type NearMatchDeficit,
  type ProjectRelevance,
  type RecommendationEntry,
  type RequiredSkill,
  type SkillId,
  type SkillMatchDetail,
  type TeamSkill,
} from '@cofoundry/shared';

/**
 * match-v3.0 (Contract Sections 04 and 05). Pure and deterministic: no I/O, no clock, no
 * randomness, no AI. Full floating-point precision is kept until display; thresholds and ranking
 * use the unrounded score. Ties are broken by candidateUserId ascending.
 */

export interface MatchBrief {
  requiredSkills: readonly RequiredSkill[];
  teamSkills: readonly TeamSkill[];
  hoursRequiredPerWeek: number;
  commitmentMonths: number;
  mandatoryAvailability: boolean;
  mandatoryCommitment: boolean;
  industryTags: readonly IndustryTag[];
  missionTags: readonly MissionTag[];
}

export interface MatchCandidate {
  userId: string;
  profileRevision: number;
  skills: ReadonlyArray<{ skillId: SkillId; level: number }>;
  availableHoursPerWeek: number;
  commitmentMonths: number;
  opportunityTypes: readonly string[];
  industryTags: readonly IndustryTag[];
  missionTags: readonly MissionTag[];
  projects: ReadonlyArray<{ id: string; title: string; skillTags: readonly SkillId[] }>;
}

export type MatchBriefProblem =
  'no_skill_gap' | 'invalid_required_skill' | 'duplicate_skill' | 'invalid_time' | 'no_interests';

/** The brief cannot be scored (Section 04/MAT-04): never divide by zero or invent a score. */
export class MatchBriefError extends Error {
  constructor(readonly problem: MatchBriefProblem) {
    super(`brief cannot be matched: ${problem}`);
    this.name = 'MatchBriefError';
  }
}

const isInt = (n: unknown, min: number, max: number) =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;

interface PreparedSkill {
  skillId: SkillId;
  requiredLevel: number;
  teamLevel: number;
  gap: number;
  importance: number;
  mandatory: boolean;
  weight: number; // importance × gap
}

export interface PreparedBrief {
  brief: MatchBrief;
  skills: PreparedSkill[];
  denominator: number;
}

/** Validates the brief once per search and precomputes gaps (Section 03/04). */
export function prepareBrief(brief: MatchBrief): PreparedBrief {
  const ids = brief.requiredSkills.map((s) => s.skillId);
  if (new Set(ids).size !== ids.length) throw new MatchBriefError('duplicate_skill');
  const teamIds = brief.teamSkills.map((s) => s.skillId);
  if (new Set(teamIds).size !== teamIds.length) throw new MatchBriefError('duplicate_skill');
  for (const s of brief.requiredSkills) {
    if (!isInt(s.level, 1, 5) || !isInt(s.importance, 1, 5)) {
      throw new MatchBriefError('invalid_required_skill');
    }
  }
  if (!isInt(brief.hoursRequiredPerWeek, 1, 40) || !isInt(brief.commitmentMonths, 1, 12)) {
    throw new MatchBriefError('invalid_time');
  }
  if (brief.industryTags.length === 0 || brief.missionTags.length === 0) {
    throw new MatchBriefError('no_interests');
  }
  const teamLevel = (id: SkillId) => brief.teamSkills.find((t) => t.skillId === id)?.level ?? 0;
  const skills = brief.requiredSkills.map((s): PreparedSkill => {
    const team = teamLevel(s.skillId);
    const gap = Math.max(0, s.level - team);
    return {
      skillId: s.skillId,
      requiredLevel: s.level,
      teamLevel: team,
      gap,
      importance: s.importance,
      mandatory: s.mandatory,
      weight: s.importance * gap,
    };
  });
  const denominator = skills.reduce((sum, s) => sum + s.weight, 0);
  if (denominator === 0) throw new MatchBriefError('no_skill_gap');
  return { brief, skills, denominator };
}

export type CandidateEvaluation =
  | { passed: false; failedGates: GateCode[] }
  | { passed: true; entry: Omit<RecommendationEntry, 'group'> & { nearMatch: boolean } };

const candidateLevel = (c: MatchCandidate, id: SkillId) =>
  c.skills.find((s) => s.skillId === id)?.level ?? 0;

/** Section 04 hard gates. Each failed gate is reported once per candidate. */
export function failedGates(prepared: PreparedBrief, c: MatchCandidate): GateCode[] {
  const b = prepared.brief;
  const failed: GateCode[] = [];
  if (!c.opportunityTypes.includes('contributor')) failed.push('opportunity_type');
  if (prepared.skills.some((s) => s.mandatory && candidateLevel(c, s.skillId) < s.requiredLevel)) {
    failed.push('essential_skill');
  }
  if (b.mandatoryAvailability && c.availableHoursPerWeek < b.hoursRequiredPerWeek) {
    failed.push('minimum_hours');
  }
  if (b.mandatoryCommitment && c.commitmentMonths < b.commitmentMonths) {
    failed.push('minimum_commitment');
  }
  return failed;
}

function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, '');
}

/** Deterministic reason templates (Section 05): top three positive contributions + deficits. */
function buildReasons(
  components: MatchComponents,
  weights: MatchWeights,
  skills: SkillMatchDetail[],
  best: ProjectRelevance | null,
  deficits: NearMatchDeficit[],
): string[] {
  const covered = skills.filter((s) => s.gap > 0 && s.fit >= 1).map((s) => SKILL_LABELS[s.skillId]);
  const templates: Record<'S' | 'A' | 'I' | 'P', string> = {
    S:
      covered.length > 0
        ? `Covers ${fmt(components.S)}% of the weighted skill gap (meets ${covered.join(', ')}).`
        : `Covers ${fmt(components.S)}% of the weighted skill gap.`,
    A: `Availability meets ${fmt(components.A)}% of the requested time.`,
    I: `Interest overlap ${fmt(components.I)}% with the brief's industries and missions.`,
    P:
      best && best.matchedGapSkills.length > 0
        ? `Project "${best.title}" is tagged with ${best.matchedGapSkills.map((s) => SKILL_LABELS[s]).join(', ')} (self-reported).`
        : 'Project tags do not cover the skill gap.',
  };
  const contributions = (['S', 'A', 'I', 'P'] as const)
    .map((f, order) => ({
      f,
      order,
      value: (weights[f] ?? 0) * (components[f] ?? 0),
    }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value || a.order - b.order)
    .slice(0, 3)
    .map((c) => templates[c.f]);
  const deficitReasons = deficits.map((d) =>
    d.factor === 'hours'
      ? `Offers ${d.offered} h/week; the brief asks for ${d.required} (not mandatory).`
      : `Offers ${d.offered} months; the brief asks for ${d.required} (not mandatory).`,
  );
  return [...contributions, ...deficitReasons];
}

/** Scores one candidate (Section 04 formulas) after the hard gates. */
export function evaluateCandidate(prepared: PreparedBrief, c: MatchCandidate): CandidateEvaluation {
  const failed = failedGates(prepared, c);
  if (failed.length > 0) return { passed: false, failedGates: failed };
  const b = prepared.brief;

  const skills: SkillMatchDetail[] = prepared.skills.map((s) => {
    const level = candidateLevel(c, s.skillId);
    return {
      skillId: s.skillId,
      requiredLevel: s.requiredLevel,
      teamLevel: s.teamLevel,
      gap: s.gap,
      importance: s.importance,
      mandatory: s.mandatory,
      candidateLevel: level,
      fit: Math.min(1, level / s.requiredLevel),
      weightShare: s.weight / prepared.denominator,
    };
  });
  const S =
    (100 * prepared.skills.reduce((sum, s, i) => sum + s.weight * skills[i]!.fit, 0)) /
    prepared.denominator;

  const H = Math.min(1, c.availableHoursPerWeek / b.hoursRequiredPerWeek);
  const D = Math.min(1, c.commitmentMonths / b.commitmentMonths);
  const A = 100 * (0.6 * H + 0.4 * D);

  const industryOverlap = b.industryTags.filter((t) => c.industryTags.includes(t)).length;
  const missionOverlap = b.missionTags.filter((t) => c.missionTags.includes(t)).length;
  const I =
    100 *
    (0.5 * (industryOverlap / b.industryTags.length) +
      0.5 * (missionOverlap / b.missionTags.length));

  const projects: ProjectRelevance[] = c.projects.map((p) => {
    const matched = prepared.skills.filter((s) => s.gap > 0 && p.skillTags.includes(s.skillId));
    return {
      projectId: p.id,
      title: p.title,
      score: (100 * matched.reduce((sum, s) => sum + s.weight, 0)) / prepared.denominator,
      matchedGapSkills: matched.map((s) => s.skillId),
    };
  });
  // Best project; ties keep the first listed project (stable, quantity never helps).
  let best: ProjectRelevance | null = null;
  for (const p of projects) if (!best || p.score > best.score) best = p;
  const P = best ? best.score : null;

  const provisional = P === null;
  const components: MatchComponents = { S, A, I, P };
  const weights: MatchWeights = provisional ? { ...PROVISIONAL_WEIGHTS } : { ...MATCH_WEIGHTS };
  const score = provisional
    ? (MATCH_WEIGHTS.S * S + MATCH_WEIGHTS.A * A + MATCH_WEIGHTS.I * I) / PROVISIONAL_COVERAGE
    : MATCH_WEIGHTS.S * S + MATCH_WEIGHTS.A * A + MATCH_WEIGHTS.I * I + MATCH_WEIGHTS.P * P!;

  // Gate-passing but below a non-mandatory time target (mandatory shortfalls were excluded).
  const deficits: NearMatchDeficit[] = [];
  if (c.availableHoursPerWeek < b.hoursRequiredPerWeek) {
    deficits.push({
      factor: 'hours',
      required: b.hoursRequiredPerWeek,
      offered: c.availableHoursPerWeek,
    });
  }
  if (c.commitmentMonths < b.commitmentMonths) {
    deficits.push({ factor: 'months', required: b.commitmentMonths, offered: c.commitmentMonths });
  }

  return {
    passed: true,
    entry: {
      candidateUserId: c.userId,
      profileRevision: c.profileRevision,
      score,
      components,
      weights,
      coverageWeight: provisional ? PROVISIONAL_COVERAGE : 1,
      provisional,
      missingFactors: provisional ? ['projectRelevance'] : [],
      nearMatchDeficits: deficits,
      nearMatch: deficits.length > 0,
      reasons: buildReasons(components, weights, skills, best, deficits),
      skills,
      projects,
      bestProjectId: best?.projectId ?? null,
    },
  };
}

export interface MatchResult {
  recommendations: RecommendationEntry[];
  provisional: RecommendationEntry[];
  nearMatches: RecommendationEntry[];
  exclusions: MatchExclusions;
  /** Gate-passing candidates scored (including those below the threshold). */
  scored: number;
}

/** Score desc, then candidateUserId asc (Section 05). */
export function compareEntries(a: { score: number; candidateUserId: string }, b: typeof a): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.candidateUserId < b.candidateUserId ? -1 : a.candidateUserId > b.candidateUserId ? 1 : 0;
}

/**
 * Runs the full search over an already privacy-filtered pool (active, discoverable, consenting,
 * same-cohort, unblocked, not the founder). Groups are mutually exclusive: near-match takes
 * precedence over provisional. Each group keeps its top three with unrounded score >= 50.
 */
export function matchCandidates(brief: MatchBrief, pool: readonly MatchCandidate[]): MatchResult {
  const prepared = prepareBrief(brief);
  const ids = pool.map((c) => c.userId);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate candidate in pool');

  const gateCounts = new Map<GateCode, number>(GATE_CODES.map((g) => [g, 0]));
  let totalExcluded = 0;
  const buckets: Record<MatchGroup, RecommendationEntry[]> = {
    recommendations: [],
    provisional: [],
    nearMatches: [],
  };
  let scored = 0;
  for (const candidate of pool) {
    const result = evaluateCandidate(prepared, candidate);
    if (!result.passed) {
      totalExcluded += 1;
      for (const g of result.failedGates) gateCounts.set(g, (gateCounts.get(g) ?? 0) + 1);
      continue;
    }
    scored += 1;
    const { nearMatch, ...entry } = result.entry;
    const group: MatchGroup = nearMatch
      ? 'nearMatches'
      : entry.provisional
        ? 'provisional'
        : 'recommendations';
    buckets[group].push({ ...entry, group });
  }
  const top = (list: RecommendationEntry[]) =>
    list
      .filter((e) => Number.isFinite(e.score) && e.score >= MATCH_SCORE_THRESHOLD)
      .sort(compareEntries)
      .slice(0, MATCH_GROUP_LIMIT);
  return {
    recommendations: top(buckets.recommendations),
    provisional: top(buckets.provisional),
    nearMatches: top(buckets.nearMatches),
    exclusions: {
      totalExcluded,
      gates: GATE_CODES.map((code) => ({ code, count: gateCounts.get(code) ?? 0 })),
    },
    scored,
  };
}
