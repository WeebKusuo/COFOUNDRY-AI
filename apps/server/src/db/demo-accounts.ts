import type { IndustryTag, MissionTag, SkillId, UserRole } from '@cofoundry/shared';

/**
 * Seeded demo identities (Section 26). These are shared demo accounts for the controlled demo,
 * labelled "demo account" in the UI and never reused for real users. Candidate names follow the
 * PayPilot matching fixture; their profiles are seeded when profiles exist (Phase 3).
 */
export interface DemoAccount {
  seedKey: string;
  email: string;
  displayName: string;
  roles: UserRole[];
}

export const DEMO_COHORT_ID = 'demo-v3.0';
export const DEMO_EMAIL_DOMAIN = 'demo.cofoundry.test';

const at = (local: string) => `${local}@${DEMO_EMAIL_DOMAIN}`;

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    seedKey: 'demo:founder:paypilot',
    email: at('founder'),
    displayName: 'Rohan (PayPilot)',
    roles: ['founder'],
  },
  { seedKey: 'demo:candidate:asha', email: at('asha'), displayName: 'Asha', roles: ['candidate'] },
  { seedKey: 'demo:candidate:dev', email: at('dev'), displayName: 'Dev', roles: ['candidate'] },
  { seedKey: 'demo:candidate:isha', email: at('isha'), displayName: 'Isha', roles: ['candidate'] },
  {
    seedKey: 'demo:candidate:kabir',
    email: at('kabir'),
    displayName: 'Kabir',
    roles: ['candidate'],
  },
  { seedKey: 'demo:candidate:mira', email: at('mira'), displayName: 'Mira', roles: ['candidate'] },
  { seedKey: 'demo:candidate:nila', email: at('nila'), displayName: 'Nila', roles: ['candidate'] },
  {
    seedKey: 'demo:candidate:hidden',
    email: at('hidden'),
    displayName: 'Hidden candidate',
    roles: ['candidate'],
  },
  {
    seedKey: 'demo:moderator',
    email: at('moderator'),
    displayName: 'Demo moderator',
    roles: ['moderator'],
  },
];

/** Development-only default; production seeding requires SEED_DEMO_PASSWORD explicitly. */
export const DEV_DEFAULT_DEMO_PASSWORD = 'cofoundry-demo-2026';

/**
 * Section 26 PayPilot matching fixture, stored as the demo candidates' profiles. Candidate inputs
 * are exactly the fixture's (skills, levels, hours, months, interests, project tags); headlines,
 * bios and project wording are illustrative seeded text.
 */
export interface DemoCandidateProfile {
  headline: string;
  bio: string;
  skills: Array<{ skillId: SkillId; level: number }>;
  industryTags: IndustryTag[];
  missionTags: MissionTag[];
  availableHoursPerWeek: number;
  commitmentMonths: number;
  projects: Array<{ title: string; description: string; skillTags: SkillId[]; url: string | null }>;
  discoverable: boolean;
}

const PAYMENTS_PROJECT = {
  title: 'Payments reconciliation API',
  description:
    'Node.js and Express service exposing REST endpoints that reconcile bank statement lines with ledger entries, with idempotent imports.',
  skillTags: ['nodejs', 'rest-api'] as SkillId[],
  url: null,
};

const ASHA: DemoCandidateProfile = {
  headline: 'Backend developer building reliable Node.js APIs',
  bio: 'I enjoy designing small, well-tested services and documenting them so others can build on them.',
  skills: [
    { skillId: 'nodejs', level: 4 },
    { skillId: 'rest-api', level: 3 },
  ],
  industryTags: ['fintech'],
  missionTags: ['reliability', 'automation'],
  availableHoursPerWeek: 10,
  commitmentMonths: 3,
  projects: [PAYMENTS_PROJECT],
  discoverable: true,
};

export const DEMO_CANDIDATE_PROFILES: Readonly<Record<string, DemoCandidateProfile>> = {
  'demo:candidate:asha': ASHA,
  'demo:candidate:dev': {
    headline: 'API developer learning Node.js in depth',
    bio: 'Comfortable designing REST resources; growing my Node.js runtime knowledge.',
    skills: [
      { skillId: 'nodejs', level: 2 },
      { skillId: 'rest-api', level: 3 },
    ],
    industryTags: ['fintech'],
    missionTags: ['reliability'],
    availableHoursPerWeek: 8,
    commitmentMonths: 3,
    projects: [
      {
        title: 'Invoice status REST API',
        description:
          'Designed resource endpoints, validation and error responses for an invoice tracking API used in a course project.',
        skillTags: ['rest-api'],
        url: null,
      },
    ],
    discoverable: true,
  },
  'demo:candidate:isha': { ...ASHA, headline: 'Node.js developer', projects: [] },
  'demo:candidate:kabir': {
    ...ASHA,
    headline: 'Node.js developer with limited hours',
    availableHoursPerWeek: 6,
  },
  'demo:candidate:mira': {
    ...ASHA,
    headline: 'Node.js developer',
    skills: [
      { skillId: 'nodejs', level: 4 },
      { skillId: 'rest-api', level: 2 },
    ],
  },
  'demo:candidate:nila': {
    ...ASHA,
    headline: 'Node.js developer, two-month window',
    commitmentMonths: 2,
  },
  'demo:candidate:hidden': { ...ASHA, headline: 'Not looking right now', discoverable: false },
};

export const DEMO_FOUNDER_PROFILES: Readonly<
  Record<string, { bio: string; companyUrl: string | null }>
> = {
  'demo:founder:paypilot': {
    bio: 'Founder of PayPilot, a payments reliability tool for small Indian businesses. Looking for a backend contributor for a bounded trial.',
    companyUrl: 'https://paypilot.example',
  },
};
