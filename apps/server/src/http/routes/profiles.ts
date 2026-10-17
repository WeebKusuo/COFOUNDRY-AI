import { Router } from 'express';
import { z } from 'zod';
import {
  INDUSTRY_TAGS,
  MISSION_TAGS,
  PROFILE_LIMITS as L,
  SKILL_IDS,
  checkHttpsUrl,
  discoveryGaps,
  discoveryRequirementMessage,
  normalizeText,
  resolveSkillId,
  type SkillId,
} from '@cofoundry/shared';
import type { ProfileService } from '../../profiles/service.js';
import { AppError } from '../errors.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { sendData } from '../respond.js';
import { objectIdString, withValidation } from '../validation.js';

/** Plain text: NFKC-normalised and trimmed before length checks (Section 03). */
const text = (min: number, max: number, label: string) =>
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

const skillId = z
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

const distinct =
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
const httpsUrlOrNull = z
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

const projectSchema = z.strictObject({
  id: objectIdString.optional(),
  title: text(1, L.projectTitleMax, 'Title'),
  description: text(L.projectDescriptionMin, L.projectDescriptionMax, 'Description'),
  skillTags: z
    .array(skillId)
    .min(L.projectSkillTagsMin, 'Tag at least one skill.')
    .max(L.projectSkillTagsMax, `Tag at most ${L.projectSkillTagsMax} skills.`)
    .superRefine(distinct('skill tags')),
  url: httpsUrlOrNull,
});

const candidateBody = z
  .strictObject({
    expectedRevision: z.number().int().min(0),
    headline: text(0, L.headlineMax, 'Headline'),
    bio: text(0, L.bioMax, 'Bio'),
    skills: z
      .array(
        z.strictObject({
          skillId,
          level: z
            .number()
            .int('Level must be a whole number.')
            .min(L.skillLevelMin)
            .max(L.skillLevelMax),
        }),
      )
      .max(L.skillsMax, `Add at most ${L.skillsMax} skills.`)
      .superRefine((skills, ctx) =>
        distinct('skills')(
          skills.map((s) => s.skillId),
          ctx,
        ),
      ),
    industryTags: z
      .array(z.enum(INDUSTRY_TAGS, { error: `Choose from: ${INDUSTRY_TAGS.join(', ')}.` }))
      .max(L.interestTagsMax, `Choose at most ${L.interestTagsMax} industries.`)
      .superRefine(distinct('industries')),
    missionTags: z
      .array(z.enum(MISSION_TAGS, { error: `Choose from: ${MISSION_TAGS.join(', ')}.` }))
      .max(L.interestTagsMax, `Choose at most ${L.interestTagsMax} missions.`)
      .superRefine(distinct('missions')),
    availableHoursPerWeek: z
      .number()
      .int('Use whole hours.')
      .min(L.hoursMin, `Use ${L.hoursMin}-${L.hoursMax} hours.`)
      .max(L.hoursMax, `Use ${L.hoursMin}-${L.hoursMax} hours.`)
      .nullable(),
    commitmentMonths: z
      .number()
      .int('Use whole months.')
      .min(L.monthsMin, `Use ${L.monthsMin}-${L.monthsMax} months.`)
      .max(L.monthsMax, `Use ${L.monthsMin}-${L.monthsMax} months.`)
      .nullable(),
    opportunityTypes: z
      .array(z.literal('contributor', { error: 'Only contributor roles exist in this version.' }))
      .max(1)
      .superRefine(distinct('opportunity types')),
    projects: z.array(projectSchema).max(L.projectsMax, `Add at most ${L.projectsMax} projects.`),
    discoveryEnabled: z.boolean(),
    discoveryConsent: z.boolean(),
  })
  .superRefine((body, ctx) => {
    // Section 03: discovery needs every non-project field and the disclosure consent.
    if (!body.discoveryEnabled) return;
    for (const gap of discoveryGaps(body)) {
      ctx.addIssue({ code: 'custom', path: [gap], message: discoveryRequirementMessage(gap) });
    }
  });

const founderBody = z.strictObject({
  expectedRevision: z.number().int().min(0),
  bio: text(0, L.bioMax, 'Bio'),
  companyUrl: httpsUrlOrNull,
});

const userIdParams = z.strictObject({ userId: z.string() });

/** Section 18 profile routes. All require a signed-in session (deny-by-default in v1). */
export function createProfileRouter(profiles: ProfileService): Router {
  const router = Router();

  router.get('/candidate/profile', requireRole('candidate'), async (req, res) => {
    sendData(res, await profiles.getCandidate(currentUser(req)));
  });

  router.put(
    '/candidate/profile',
    requireRole('candidate'),
    withValidation({ body: candidateBody }, async ({ body }, req, res) => {
      sendData(res, await profiles.updateCandidate(currentUser(req), body));
    }),
  );

  router.get('/founder/profile', requireRole('founder'), async (req, res) => {
    sendData(res, await profiles.getFounder(currentUser(req)));
  });

  router.put(
    '/founder/profile',
    requireRole('founder'),
    withValidation({ body: founderBody }, async ({ body }, req, res) => {
      sendData(res, await profiles.updateFounder(currentUser(req), body));
    }),
  );

  router.get(
    '/profiles/:userId',
    withValidation({ params: userIdParams }, async ({ params }, req, res) => {
      // A malformed id is indistinguishable from an unknown one (no existence probing).
      if (!objectIdString.safeParse(params.userId).success) {
        throw new AppError('NOT_FOUND', 'The requested resource was not found.');
      }
      sendData(res, await profiles.getPublic(currentUser(req), params.userId));
    }),
  );

  return router;
}
