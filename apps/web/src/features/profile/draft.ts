import {
  PROFILE_LIMITS as L,
  checkHttpsUrl,
  discoveryGaps,
  type CandidateProfileData,
  type CandidateProfileUpdate,
  type DiscoveryRequirement,
  type IndustryTag,
  type MissionTag,
  type SkillId,
} from '@cofoundry/shared';

/**
 * Client-side editing model for the candidate profile. The server re-validates everything; these
 * checks only give earlier, friendlier feedback with the same limits (shared constants).
 */

export interface SkillDraft {
  key: string;
  skillId: SkillId | '';
  level: number;
}

export interface ProjectDraft {
  key: string;
  id?: string;
  title: string;
  description: string;
  skillTags: SkillId[];
  url: string;
}

export interface CandidateDraft {
  headline: string;
  bio: string;
  skills: SkillDraft[];
  industryTags: IndustryTag[];
  missionTags: MissionTag[];
  hours: string;
  months: string;
  contributor: boolean;
  projects: ProjectDraft[];
  discoveryEnabled: boolean;
  discoveryConsent: boolean;
}

let keySeq = 0;
export const newKey = () => `k${(keySeq += 1)}`;

export function draftFromProfile(p: CandidateProfileData): CandidateDraft {
  return {
    headline: p.headline,
    bio: p.bio,
    skills: p.skills.map((s) => ({ key: newKey(), skillId: s.skillId, level: s.level })),
    industryTags: [...p.industryTags],
    missionTags: [...p.missionTags],
    hours: p.availableHoursPerWeek === null ? '' : String(p.availableHoursPerWeek),
    months: p.commitmentMonths === null ? '' : String(p.commitmentMonths),
    contributor: p.opportunityTypes.includes('contributor'),
    projects: p.projects.map((pr) => ({
      key: newKey(),
      id: pr.id,
      title: pr.title,
      description: pr.description,
      skillTags: [...pr.skillTags],
      url: pr.url ?? '',
    })),
    discoveryEnabled: p.discoveryEnabled,
    discoveryConsent: p.discoveryConsent,
  };
}

const toNumberOrNull = (value: string): number | null => {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : NaN;
};

export function draftToUpdate(
  draft: CandidateDraft,
  expectedRevision: number,
): CandidateProfileUpdate {
  return {
    expectedRevision,
    headline: draft.headline,
    bio: draft.bio,
    skills: draft.skills
      .filter((s) => s.skillId !== '')
      .map((s) => ({ skillId: s.skillId, level: s.level })),
    industryTags: draft.industryTags,
    missionTags: draft.missionTags,
    availableHoursPerWeek: toNumberOrNull(draft.hours),
    commitmentMonths: toNumberOrNull(draft.months),
    opportunityTypes: draft.contributor ? ['contributor'] : [],
    projects: draft.projects.map((p) => ({
      ...(p.id ? { id: p.id } : {}),
      title: p.title,
      description: p.description,
      skillTags: p.skillTags,
      url: p.url.trim() === '' ? null : p.url.trim(),
    })),
    discoveryEnabled: draft.discoveryEnabled,
    discoveryConsent: draft.discoveryConsent,
  };
}

/** Comparable form of a draft (ignores client-only keys) for "unsaved changes" detection. */
export function draftSignature(draft: CandidateDraft): string {
  return JSON.stringify(draftToUpdate(draft, 0));
}

/** Discovery requirements still unmet by the current draft (Section 03). */
export function draftDiscoveryGaps(draft: CandidateDraft): DiscoveryRequirement[] {
  const u = draftToUpdate(draft, 0);
  return discoveryGaps({
    ...u,
    availableHoursPerWeek: Number.isInteger(u.availableHoursPerWeek)
      ? u.availableHoursPerWeek
      : null,
    commitmentMonths: Number.isInteger(u.commitmentMonths) ? u.commitmentMonths : null,
  });
}

const length = (s: string) => Array.from(s.normalize('NFKC').trim()).length;

/**
 * Field errors keyed like the server's (`body.<path>`) so both sources render the same way.
 * Discovery gaps are reported only when discovery is switched on.
 */
export function validateDraft(draft: CandidateDraft): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  const add = (key: string, message: string) => (errors[`body.${key}`] ??= []).push(message);

  if (length(draft.headline) > L.headlineMax)
    add('headline', `Headline can be at most ${L.headlineMax} characters.`);
  if (length(draft.bio) > L.bioMax) add('bio', `Bio can be at most ${L.bioMax} characters.`);

  draft.skills.forEach((s, i) => {
    if (s.skillId === '') add(`skills.${i}.skillId`, 'Choose a skill or remove this row.');
  });
  const chosen = draft.skills.map((s) => s.skillId).filter(Boolean);
  if (new Set(chosen).size !== chosen.length) add('skills', 'Remove duplicate skills.');

  const hours = toNumberOrNull(draft.hours);
  if (hours !== null && (!Number.isInteger(hours) || hours < L.hoursMin || hours > L.hoursMax)) {
    add('availableHoursPerWeek', `Use whole hours from ${L.hoursMin} to ${L.hoursMax}.`);
  }
  const months = toNumberOrNull(draft.months);
  if (
    months !== null &&
    (!Number.isInteger(months) || months < L.monthsMin || months > L.monthsMax)
  ) {
    add('commitmentMonths', `Use whole months from ${L.monthsMin} to ${L.monthsMax}.`);
  }

  draft.projects.forEach((p, i) => {
    if (length(p.title) < 1) add(`projects.${i}.title`, 'Title is required.');
    if (length(p.title) > L.projectTitleMax)
      add(`projects.${i}.title`, `Title can be at most ${L.projectTitleMax} characters.`);
    const d = length(p.description);
    if (d < L.projectDescriptionMin || d > L.projectDescriptionMax) {
      add(
        `projects.${i}.description`,
        `Description needs ${L.projectDescriptionMin}-${L.projectDescriptionMax} characters.`,
      );
    }
    if (p.skillTags.length < L.projectSkillTagsMin)
      add(`projects.${i}.skillTags`, 'Tag at least one skill.');
    if (p.url.trim() !== '') {
      const check = checkHttpsUrl(p.url.trim());
      if (!check.ok) add(`projects.${i}.url`, 'Enter a public link starting with https://.');
    }
  });

  return errors;
}

export function newProjectDraft(): ProjectDraft {
  return { key: newKey(), title: '', description: '', skillTags: [], url: '' };
}
