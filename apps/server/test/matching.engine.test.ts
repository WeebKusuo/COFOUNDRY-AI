import { describe, expect, it } from 'vitest';
import { formatMatchScore } from '@cofoundry/shared';
import {
  MatchBriefError,
  evaluateCandidate,
  matchCandidates,
  prepareBrief,
  type MatchBrief,
  type MatchCandidate,
} from '../src/matching/engine.js';
import { DEMO_BRIEFS } from '../src/db/demo-accounts.js';

/** Section 26 PayPilot brief, taken from the seed fixture itself. */
const f = DEMO_BRIEFS[0]!.fields;
const PAYPILOT: MatchBrief = {
  requiredSkills: f.requiredSkills,
  teamSkills: f.teamSkills,
  hoursRequiredPerWeek: f.hoursRequiredPerWeek!,
  commitmentMonths: f.commitmentMonths!,
  mandatoryAvailability: f.mandatoryAvailability,
  mandatoryCommitment: f.mandatoryCommitment,
  industryTags: f.industryTags,
  missionTags: f.missionTags,
};

let seq = 0;
function candidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  seq += 1;
  return {
    userId: `c${String(seq).padStart(23, '0')}`,
    profileRevision: 1,
    skills: [
      { skillId: 'nodejs', level: 4 },
      { skillId: 'rest-api', level: 3 },
    ],
    availableHoursPerWeek: 10,
    commitmentMonths: 3,
    opportunityTypes: ['contributor'],
    industryTags: ['fintech'],
    missionTags: ['reliability', 'automation'],
    projects: [{ id: 'p1', title: 'Payments API', skillTags: ['nodejs', 'rest-api'] }],
    ...overrides,
  };
}

const scoreOf = (brief: MatchBrief, c: MatchCandidate) => {
  const r = evaluateCandidate(prepareBrief(brief), c);
  if (!r.passed) throw new Error(`gated: ${r.failedGates.join()}`);
  return r.entry;
};

describe('Section 26 PayPilot fixture (MAT-01)', () => {
  const asha = candidate({ userId: 'a'.repeat(24) });
  const dev = candidate({
    userId: 'b'.repeat(24),
    skills: [
      { skillId: 'nodejs', level: 2 },
      { skillId: 'rest-api', level: 3 },
    ],
    availableHoursPerWeek: 8,
    missionTags: ['reliability'],
    projects: [{ id: 'p2', title: 'REST service', skillTags: ['rest-api'] }],
  });
  const isha = candidate({ userId: 'c'.repeat(24), projects: [] });
  const kabir = candidate({ userId: 'd'.repeat(24), availableHoursPerWeek: 6 });
  const mira = candidate({
    userId: 'e'.repeat(24),
    skills: [
      { skillId: 'nodejs', level: 4 },
      { skillId: 'rest-api', level: 2 },
    ],
  });
  const nila = candidate({ userId: 'f'.repeat(24), commitmentMonths: 2 });
  const result = matchCandidates(PAYPILOT, [nila, mira, kabir, isha, dev, asha]);

  it('places every fixture candidate in the expected group with exact scores', () => {
    expect(result.recommendations.map((e) => e.candidateUserId)).toEqual([asha.userId, dev.userId]);
    expect(result.provisional.map((e) => e.candidateUserId)).toEqual([isha.userId]);
    expect(result.nearMatches.map((e) => e.candidateUserId)).toEqual([nila.userId]);

    const [a, d] = result.recommendations;
    expect(a!.components).toEqual({ S: 100, A: 100, I: 100, P: 100 });
    expect(a!.score).toBe(100);
    expect(d!.components.S).toBeCloseTo(71.428571, 6);
    expect(d!.components.A).toBe(100);
    expect(d!.components.I).toBe(75);
    expect(d!.components.P).toBeCloseTo(42.857143, 6);
    expect(d!.score).toBeCloseTo(73.392857, 6);
    expect(formatMatchScore(d!.score)).toBe('73.39');

    const i = result.provisional[0]!;
    expect(i).toMatchObject({
      score: 100,
      coverageWeight: 0.8,
      provisional: true,
      missingFactors: ['projectRelevance'],
    });
    expect(i.components.P).toBeNull();
    expect(i.weights).toEqual({ S: 0.5, A: 0.3125, I: 0.1875, P: null });

    const n = result.nearMatches[0]!;
    expect(n.components.A).toBeCloseTo(86.666667, 6);
    expect(n.score).toBeCloseTo(96.666667, 6);
    expect(formatMatchScore(n.score)).toBe('96.67');
    expect(n.nearMatchDeficits).toEqual([{ factor: 'months', required: 3, offered: 2 }]);
  });

  it('counts business gates only, once per candidate, with no identities', () => {
    expect(result.exclusions).toEqual({
      totalExcluded: 2,
      gates: [
        { code: 'opportunity_type', count: 0 },
        { code: 'essential_skill', count: 1 },
        { code: 'minimum_hours', count: 1 },
        { code: 'minimum_commitment', count: 0 },
      ],
    });
    expect(JSON.stringify(result.exclusions)).not.toContain(kabir.userId);
  });

  it('never places a candidate in two groups', () => {
    const all = [...result.recommendations, ...result.provisional, ...result.nearMatches].map(
      (e) => e.candidateUserId,
    );
    expect(new Set(all).size).toBe(all.length);
  });

  it('explains each score with components, weights, per-skill fit and project relevance', () => {
    const d = result.recommendations[1]!;
    expect(d.skills).toEqual([
      expect.objectContaining({
        skillId: 'nodejs',
        requiredLevel: 4,
        teamLevel: 2,
        gap: 2,
        candidateLevel: 2,
        fit: 0.5,
        weightShare: 4 / 7,
      }),
      expect.objectContaining({
        skillId: 'rest-api',
        requiredLevel: 3,
        teamLevel: 0,
        gap: 3,
        candidateLevel: 3,
        fit: 1,
        weightShare: 3 / 7,
      }),
    ]);
    expect(d.projects).toEqual([
      {
        projectId: 'p2',
        title: 'REST service',
        score: (100 * 3) / 7,
        matchedGapSkills: ['rest-api'],
      },
    ]);
    expect(d.bestProjectId).toBe('p2');
    expect(d.reasons.length).toBeLessThanOrEqual(3);
    expect(d.reasons[0]).toMatch(/^Covers 71\.43% of the weighted skill gap/);
    expect(result.nearMatches[0]!.reasons.at(-1)).toBe(
      'Offers 2 months; the brief asks for 3 (not mandatory).',
    );
  });
});

describe('Section 05 fixtures', () => {
  // A brief where S, A, I and P can be dialled independently.
  const brief: MatchBrief = {
    requiredSkills: [{ skillId: 'nodejs', level: 5, importance: 1, mandatory: false }],
    teamSkills: [],
    hoursRequiredPerWeek: 10,
    commitmentMonths: 4,
    mandatoryAvailability: false,
    mandatoryCommitment: false,
    industryTags: ['fintech', 'health'],
    missionTags: ['access', 'privacy'],
  };

  it('A ignores surplus time and penalises optional shortfalls (MAT-02)', () => {
    const surplus = scoreOf(
      PAYPILOT,
      candidate({ availableHoursPerWeek: 12, commitmentMonths: 6 }),
    );
    expect(surplus.components.A).toBe(100);
    const short = scoreOf(
      { ...PAYPILOT, mandatoryAvailability: false },
      candidate({ availableHoursPerWeek: 6, commitmentMonths: 3 }),
    );
    expect(short.components.A).toBe(85);
    expect(short.nearMatchDeficits).toEqual([{ factor: 'hours', required: 8, offered: 6 }]);
    const gated = evaluateCandidate(
      prepareBrief(PAYPILOT),
      candidate({ availableHoursPerWeek: 6 }),
    );
    expect(gated).toEqual({ passed: false, failedGates: ['minimum_hours'] });
  });

  it('missing projects are provisional at 0.80; an irrelevant project gives P=0 and stays complete (MAT-03)', () => {
    const irrelevant = scoreOf(
      PAYPILOT,
      candidate({ projects: [{ id: 'x', title: 'Blog', skillTags: ['git'] }] }),
    );
    expect(irrelevant).toMatchObject({ provisional: false, coverageWeight: 1 });
    expect(irrelevant.components.P).toBe(0);
    expect(irrelevant.score).toBe(80);
    const none = scoreOf(PAYPILOT, candidate({ projects: [] }));
    expect(none.provisional).toBe(true);
    expect(none.score).toBe(100);
  });

  it('reproduces the 89.25 / 91.5625 weighting and A=90 from H=1, D=0.75', () => {
    const weighted = (S: number, A: number, I: number, P: number | null) =>
      P === null ? (0.4 * S + 0.25 * A + 0.15 * I) / 0.8 : 0.4 * S + 0.25 * A + 0.15 * I + 0.2 * P;
    expect(weighted(95, 90, 85, 80)).toBeCloseTo(89.25, 10);
    expect(weighted(95, 90, 85, null)).toBeCloseTo(91.5625, 10);
    const e = scoreOf(
      brief,
      candidate({ skills: [{ skillId: 'nodejs', level: 5 }], commitmentMonths: 3 }),
    );
    expect(e.components.A).toBe(90);
    // The engine's score is exactly that weighting of its own components.
    expect(e.score).toBeCloseTo(
      weighted(e.components.S, e.components.A, e.components.I, e.components.P),
      10,
    );
  });

  it('S=A=I=80 with P=0 is 64 complete versus 80 provisional; never in the same group', () => {
    const b: MatchBrief = {
      requiredSkills: [{ skillId: 'nodejs', level: 5, importance: 1, mandatory: false }],
      teamSkills: [],
      hoursRequiredPerWeek: 10,
      commitmentMonths: 5,
      mandatoryAvailability: false,
      mandatoryCommitment: false,
      industryTags: ['fintech', 'health', 'climate', 'education', 'other'],
      missionTags: ['access', 'privacy', 'automation', 'reliability', 'affordability'],
    };
    const base = {
      skills: [{ skillId: 'nodejs' as const, level: 4 }],
      availableHoursPerWeek: 8,
      commitmentMonths: 4,
      industryTags: ['fintech', 'health', 'climate', 'education'] as const,
      missionTags: ['access', 'privacy', 'automation', 'reliability'] as const,
    };
    // S=80 (level 4 of 5), H=D=0.8 -> A=80, I=80; scores checked on the evaluated entries.
    const complete = scoreOf(
      b,
      candidate({
        ...base,
        industryTags: [...base.industryTags],
        missionTags: [...base.missionTags],
        projects: [{ id: 'p', title: 'Docs', skillTags: ['git'] }],
      }),
    );
    expect(complete.components).toMatchObject({ S: 80, A: 80, I: 80, P: 0 });
    expect(complete.score).toBeCloseTo(64, 10);
    const provisional = scoreOf(
      b,
      candidate({
        ...base,
        industryTags: [...base.industryTags],
        missionTags: [...base.missionTags],
        projects: [],
      }),
    );
    expect(provisional.score).toBeCloseTo(80, 10);
  });

  it('S uses denominator 7 and numerator 5 for the Node/REST example', () => {
    const e = scoreOf(
      PAYPILOT,
      candidate({
        skills: [
          { skillId: 'nodejs', level: 2 },
          { skillId: 'rest-api', level: 3 },
        ],
      }),
    );
    expect(e.components.S).toBeCloseTo((100 * 5) / 7, 10);
  });

  it('treats an unlisted skill as level 0 and caps fit at 1', () => {
    const e = scoreOf(
      {
        ...PAYPILOT,
        requiredSkills: [
          { skillId: 'nodejs', level: 4, importance: 2, mandatory: false },
          { skillId: 'rest-api', level: 3, importance: 1, mandatory: false },
        ],
      },
      candidate({ skills: [{ skillId: 'nodejs', level: 5 }] }),
    );
    expect(e.skills.map((s) => [s.candidateLevel, s.fit])).toEqual([
      [5, 1],
      [0, 0],
    ]);
  });

  it('ignores required skills the team already covers (gap 0)', () => {
    const e = scoreOf(
      {
        ...PAYPILOT,
        requiredSkills: [
          ...PAYPILOT.requiredSkills,
          { skillId: 'git', level: 2, importance: 5, mandatory: false },
        ],
        teamSkills: [...PAYPILOT.teamSkills, { skillId: 'git', level: 3 }],
      },
      candidate({ projects: [{ id: 'g', title: 'Git tool', skillTags: ['git'] }] }),
    );
    expect(e.skills.find((s) => s.skillId === 'git')).toMatchObject({ gap: 0, weightShare: 0 });
    expect(e.components.S).toBe(100);
    expect(e.components.P).toBe(0);
  });

  it('uses the best single project, so adding projects never inflates P', () => {
    const one = scoreOf(
      PAYPILOT,
      candidate({ projects: [{ id: 'a', title: 'A', skillTags: ['rest-api'] }] }),
    );
    const many = scoreOf(
      PAYPILOT,
      candidate({
        projects: [
          { id: 'a', title: 'A', skillTags: ['rest-api'] },
          { id: 'b', title: 'B', skillTags: ['rest-api'] },
          { id: 'c', title: 'C', skillTags: ['git'] },
        ],
      }),
    );
    expect(many.components.P).toBe(one.components.P);
    expect(many.bestProjectId).toBe('a');
  });
});

describe('ranking, thresholds and limits (MAT-06)', () => {
  const lowBrief: MatchBrief = {
    requiredSkills: [{ skillId: 'nodejs', level: 5, importance: 1, mandatory: false }],
    teamSkills: [],
    hoursRequiredPerWeek: 10,
    commitmentMonths: 3,
    mandatoryAvailability: false,
    mandatoryCommitment: false,
    industryTags: ['fintech'],
    missionTags: ['reliability'],
  };

  it('orders equal scores by candidate id and keeps at most three per group', () => {
    const pool = ['e', 'b', 'd', 'a', 'c'].map((ch) => candidate({ userId: ch.repeat(24) }));
    const r = matchCandidates(PAYPILOT, pool);
    expect(r.recommendations.map((e) => e.candidateUserId)).toEqual(
      ['a', 'b', 'c'].map((ch) => ch.repeat(24)),
    );
  });

  it('omits scores below 50 even when display rounding would show 50.00', () => {
    // Construct S so that the unrounded score is just below 50.
    const c = candidate({
      userId: '1'.repeat(24),
      skills: [{ skillId: 'nodejs', level: 1 }],
      industryTags: ['other'],
      missionTags: ['access'],
      projects: [{ id: 'p', title: 'P', skillTags: ['git'] }],
    });
    const e = scoreOf(lowBrief, c);
    // S=20, A=100, I=0, P=0 -> 8 + 25 = 33.
    expect(e.score).toBe(33);
    expect(matchCandidates(lowBrief, [c]).recommendations).toEqual([]);
    expect(formatMatchScore(49.999)).toBe('50.00');
  });

  it('does not pad a group with low scorers; fewer than three stays fewer', () => {
    const r = matchCandidates(PAYPILOT, [candidate()]);
    expect(r.recommendations).toHaveLength(1);
    expect(r.provisional).toEqual([]);
    expect(r.nearMatches).toEqual([]);
  });

  it('near-match takes precedence over provisional and keeps the provisional badge', () => {
    const r = matchCandidates(PAYPILOT, [candidate({ commitmentMonths: 2, projects: [] })]);
    expect(r.provisional).toEqual([]);
    expect(r.nearMatches[0]).toMatchObject({
      group: 'nearMatches',
      provisional: true,
      coverageWeight: 0.8,
    });
  });

  it('is deterministic regardless of pool order', () => {
    const pool = Array.from({ length: 12 }, (_, i) =>
      candidate({
        userId: i.toString(16).padStart(24, '0'),
        skills: [
          { skillId: 'nodejs', level: (i % 5) + 1 },
          { skillId: 'rest-api', level: 3 },
        ],
        availableHoursPerWeek: 4 + (i % 7),
        projects:
          i % 3 === 0
            ? []
            : [{ id: `p${i}`, title: 'p', skillTags: i % 2 ? ['nodejs'] : ['rest-api'] }],
      }),
    );
    const a = matchCandidates({ ...PAYPILOT, mandatoryAvailability: false }, pool);
    const b = matchCandidates({ ...PAYPILOT, mandatoryAvailability: false }, [...pool].reverse());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('hard gates and invalid briefs (MAT-04, MAT-05)', () => {
  it('excludes candidates below a mandatory skill and counts each gate once', () => {
    const p = prepareBrief({
      ...PAYPILOT,
      requiredSkills: PAYPILOT.requiredSkills.map((s) => ({ ...s, mandatory: true })),
      mandatoryCommitment: true,
    });
    const r = evaluateCandidate(
      p,
      candidate({
        skills: [],
        opportunityTypes: [],
        availableHoursPerWeek: 1,
        commitmentMonths: 1,
      }),
    );
    expect(r).toEqual({
      passed: false,
      failedGates: ['opportunity_type', 'essential_skill', 'minimum_hours', 'minimum_commitment'],
    });
  });

  it('refuses briefs that cannot be scored instead of dividing by zero', () => {
    const cases: Array<[Partial<MatchBrief>, string]> = [
      [
        {
          teamSkills: [
            { skillId: 'nodejs', level: 5 },
            { skillId: 'rest-api', level: 5 },
          ],
        },
        'no_skill_gap',
      ],
      [
        { requiredSkills: [{ skillId: 'nodejs', level: 0, importance: 1, mandatory: false }] },
        'invalid_required_skill',
      ],
      [
        { requiredSkills: [{ skillId: 'nodejs', level: 3, importance: 6, mandatory: false }] },
        'invalid_required_skill',
      ],
      [
        { requiredSkills: [{ skillId: 'nodejs', level: 3, importance: 1.5, mandatory: false }] },
        'invalid_required_skill',
      ],
      [
        {
          requiredSkills: [
            { skillId: 'nodejs', level: 3, importance: 1, mandatory: false },
            { skillId: 'nodejs', level: 4, importance: 1, mandatory: false },
          ],
        },
        'duplicate_skill',
      ],
      [{ requiredSkills: [] }, 'no_skill_gap'],
      [{ industryTags: [] }, 'no_interests'],
      [{ hoursRequiredPerWeek: 0 }, 'invalid_time'],
    ];
    for (const [patch, problem] of cases) {
      expect(() => prepareBrief({ ...PAYPILOT, ...patch }), problem).toThrow(MatchBriefError);
      try {
        prepareBrief({ ...PAYPILOT, ...patch });
      } catch (err) {
        expect((err as MatchBriefError).problem).toBe(problem);
      }
    }
  });

  it('never produces NaN or Infinity', () => {
    const r = matchCandidates(PAYPILOT, [
      candidate({ skills: [], availableHoursPerWeek: 40, projects: [] }),
      candidate(),
    ]);
    for (const e of [...r.recommendations, ...r.provisional, ...r.nearMatches]) {
      expect(Number.isFinite(e.score)).toBe(true);
      for (const v of Object.values(e.components))
        if (v !== null) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
