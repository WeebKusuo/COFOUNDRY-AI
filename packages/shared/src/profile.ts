import type { IndustryTag, MissionTag, SkillId } from './constants.js';

/**
 * Profile contracts (Sections 03, 14, 18). Profiles hold self-reported data only. Projects with a
 * syntactically valid HTTPS link are labelled "project_linked", which never means the link was
 * fetched or checked. The optional private resume (Phase 4 amendment) lives in resume.ts and is
 * never part of any profile projection.
 */

export const PROFILE_LIMITS = {
  headlineMax: 160,
  bioMax: 1000,
  skillsMax: 12,
  skillLevelMin: 1,
  skillLevelMax: 5,
  hoursMin: 1,
  hoursMax: 40,
  monthsMin: 1,
  monthsMax: 12,
  interestTagsMax: 5,
  projectsMax: 5,
  projectTitleMax: 100,
  projectDescriptionMin: 50,
  projectDescriptionMax: 1500,
  projectSkillTagsMin: 1,
  projectSkillTagsMax: 8,
} as const;

/** Version of the profile-disclosure notice the candidate consents to before discovery. */
export const PROFILE_DISCLOSURE_POLICY_VERSION = 'profile-disclosure-v3.0';

export const PROFILE_DISCLOSURE_NOTICE =
  'Founders searching in this cohort can see your display name, headline, bio, skills, ' +
  'availability, interests and projects (including links you add). Your email and account ' +
  'details are never shown. You can turn discovery off at any time.';

export type EvidenceStatus = 'self_reported' | 'project_linked';

export interface SkillEntry {
  skillId: SkillId;
  level: number;
}

export interface CandidateProject {
  id: string;
  title: string;
  description: string;
  skillTags: SkillId[];
  url: string | null;
  evidenceStatus: EvidenceStatus;
}

/** GET/PUT /candidate/profile — the owner's complete editable profile. */
export interface CandidateProfileData {
  userId: string;
  /** 0 means no profile has been saved yet (first PUT uses expectedRevision 0). */
  revision: number;
  headline: string;
  bio: string;
  skills: SkillEntry[];
  industryTags: IndustryTag[];
  missionTags: MissionTag[];
  availableHoursPerWeek: number | null;
  commitmentMonths: number | null;
  opportunityTypes: Array<'contributor'>;
  projects: CandidateProject[];
  discoveryEnabled: boolean;
  /** True while an active profile-discovery consent record exists. */
  discoveryConsent: boolean;
  updatedAt: string | null;
}

/** Project as sent by the client; `id` identifies an existing project to keep. */
export interface CandidateProjectInput {
  id?: string;
  title: string;
  description: string;
  skillTags: string[];
  url: string | null;
}

/** PUT /candidate/profile request body (all fields required; drafts may hold empty values). */
export interface CandidateProfileUpdate {
  expectedRevision: number;
  headline: string;
  bio: string;
  skills: Array<{ skillId: string; level: number }>;
  industryTags: string[];
  missionTags: string[];
  availableHoursPerWeek: number | null;
  commitmentMonths: number | null;
  opportunityTypes: string[];
  projects: CandidateProjectInput[];
  discoveryEnabled: boolean;
  discoveryConsent: boolean;
}

/** GET/PUT /founder/profile. */
export interface FounderProfileData {
  userId: string;
  revision: number;
  bio: string;
  companyUrl: string | null;
  updatedAt: string | null;
}

export interface FounderProfileUpdate {
  expectedRevision: number;
  bio: string;
  companyUrl: string | null;
}

/**
 * GET /profiles/:userId — ProfilePublic. Never contains email, consent records, revision or
 * other private account fields.
 */
export interface ProfilePublic {
  userId: string;
  displayName: string;
  /** Seeded identities are labelled "demo account", never "verified". */
  demoAccount: boolean;
  candidate: {
    headline: string;
    bio: string;
    skills: SkillEntry[];
    industryTags: IndustryTag[];
    missionTags: MissionTag[];
    availableHoursPerWeek: number | null;
    commitmentMonths: number | null;
    projects: CandidateProject[];
  } | null;
  founder: { bio: string; companyUrl: string | null } | null;
}

export type DiscoveryRequirement =
  | 'skills'
  | 'industryTags'
  | 'missionTags'
  | 'availableHoursPerWeek'
  | 'commitmentMonths'
  | 'opportunityTypes'
  | 'discoveryConsent';

const REQUIREMENT_MESSAGES: Record<DiscoveryRequirement, string> = {
  skills: 'Add at least one skill.',
  industryTags: 'Choose at least one industry.',
  missionTags: 'Choose at least one mission.',
  availableHoursPerWeek: 'Set your weekly hours.',
  commitmentMonths: 'Set how many months you can commit.',
  opportunityTypes: 'Confirm you are open to contributor roles.',
  discoveryConsent: 'Agree to the profile disclosure notice.',
};

export function discoveryRequirementMessage(requirement: DiscoveryRequirement): string {
  return REQUIREMENT_MESSAGES[requirement];
}

/**
 * Section 03: discovery can be enabled only when every non-project field is complete and the
 * disclosure consent is granted. Projects are optional (missing projects make a provisional
 * score later, never a hidden profile). Returns the unmet requirements, empty when ready.
 */
export function discoveryGaps(profile: {
  skills: readonly unknown[];
  industryTags: readonly unknown[];
  missionTags: readonly unknown[];
  availableHoursPerWeek: number | null;
  commitmentMonths: number | null;
  opportunityTypes: readonly string[];
  discoveryConsent: boolean;
}): DiscoveryRequirement[] {
  const gaps: DiscoveryRequirement[] = [];
  if (profile.skills.length < 1) gaps.push('skills');
  if (profile.industryTags.length < 1) gaps.push('industryTags');
  if (profile.missionTags.length < 1) gaps.push('missionTags');
  if (profile.availableHoursPerWeek === null) gaps.push('availableHoursPerWeek');
  if (profile.commitmentMonths === null) gaps.push('commitmentMonths');
  if (!profile.opportunityTypes.includes('contributor')) gaps.push('opportunityTypes');
  if (!profile.discoveryConsent) gaps.push('discoveryConsent');
  return gaps;
}

/** Display labels for the canonical tags (Section 03). */
export const SKILL_LABELS: Readonly<Record<SkillId, string>> = {
  nodejs: 'Node.js',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  'rest-api': 'REST APIs',
  authentication: 'Authentication',
  mongodb: 'MongoDB',
  sql: 'SQL',
  testing: 'Testing',
  debugging: 'Debugging',
  docker: 'Docker',
  git: 'Git',
  'system-design': 'System design',
};

export const INDUSTRY_LABELS: Readonly<Record<IndustryTag, string>> = {
  fintech: 'Fintech',
  education: 'Education',
  health: 'Health',
  commerce: 'Commerce',
  climate: 'Climate',
  productivity: 'Productivity',
  'developer-tools': 'Developer tools',
  other: 'Other',
};

export const MISSION_LABELS: Readonly<Record<MissionTag, string>> = {
  access: 'Access',
  affordability: 'Affordability',
  privacy: 'Privacy',
  sustainability: 'Sustainability',
  automation: 'Automation',
  reliability: 'Reliability',
};

/** Self-assessed proficiency, 1-5 (Section 03). */
export const SKILL_LEVEL_LABELS: Readonly<Record<number, string>> = {
  1: 'Beginner',
  2: 'Working',
  3: 'Solid',
  4: 'Strong',
  5: 'Expert',
};
