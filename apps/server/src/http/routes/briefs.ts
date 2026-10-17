import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  BRIEF_LIMITS as L,
  COMPENSATION_TYPES,
  INDUSTRY_TAGS,
  MISSION_TAGS,
  SKILL_IDS,
  emptyBriefDraft,
} from '@cofoundry/shared';
import type { BriefService } from '../../briefs/service.js';
import type { IdempotencyStore } from '../../briefs/store.js';
import { AppError } from '../errors.js';
import { runIdempotent } from '../idempotency.js';
import { currentUser, requireRole } from '../middleware/auth.js';
import { encodeCursor, pageQuery, pageRequest } from '../pagination.js';
import { sendData, sendList } from '../respond.js';
import { distinct, intRange, skillId, text } from '../schemas.js';
import { objectIdString, withValidation } from '../validation.js';

const tags = <T extends readonly [string, ...string[]]>(values: T, label: string) =>
  z
    .array(z.enum(values, { error: `Choose from: ${values.join(', ')}.` }))
    .max(L.interestTagsMax, `Choose at most ${L.interestTagsMax} ${label}.`)
    .superRefine(distinct(label));

const level = (min: number, max: number) =>
  z
    .number({ error: 'Choose a level.' })
    .int('Use a whole number.')
    .min(min, `Use ${min}-${max}.`)
    .max(max, `Use ${min}-${max}.`);

const teamSkills = z
  .array(z.strictObject({ skillId, level: level(L.teamLevelMin, L.teamLevelMax) }))
  .max(SKILL_IDS.length)
  .superRefine((items, ctx) =>
    distinct('team skills')(
      items.map((s) => s.skillId),
      ctx,
    ),
  );

const requiredSkills = z
  .array(
    z.strictObject({
      skillId,
      level: level(L.requiredLevelMin, L.requiredLevelMax),
      importance: level(L.importanceMin, L.importanceMax),
      mandatory: z.boolean(),
    }),
  )
  .max(L.requiredSkillsMax, `Add at most ${L.requiredSkillsMax} required skills.`)
  .superRefine((items, ctx) =>
    distinct('required skills')(
      items.map((s) => s.skillId),
      ctx,
    ),
  );

/** Draft compensation: complete-for-type is checked at publish, not while drafting. */
const compensation = z.strictObject({
  type: z.enum(COMPENSATION_TYPES, { error: 'Choose paid, credit_reference or unpaid.' }),
  amountMinor: z
    .number({ error: 'Enter the amount in paise.' })
    .int('Amounts are whole paise.')
    .min(1, 'Amount must be at least ₹0.01.')
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  paymentDueDays: intRange(L.paymentDueDaysMin, L.paymentDueDaysMax, 'days').nullable(),
  methodNote: text(0, L.methodNoteMax, 'Payment method'),
  benefitDescription: text(0, L.benefitDescriptionMax, 'Benefit description'),
});

/** Every writable draft field (Section 14 minus server fields), each optional. */
const draftFields = {
  title: text(1, L.titleMax, 'Title'),
  teaser: text(0, L.teaserMax, 'Teaser'),
  problem: text(0, L.problemMax, 'Problem'),
  solution: text(0, L.solutionMax, 'Solution'),
  industryTags: tags(INDUSTRY_TAGS, 'industries'),
  missionTags: tags(MISSION_TAGS, 'missions'),
  teamSkills,
  requiredSkills,
  hoursRequiredPerWeek: intRange(L.hoursMin, L.hoursMax, 'hours').nullable(),
  commitmentMonths: intRange(L.monthsMin, L.monthsMax, 'months').nullable(),
  mandatoryAvailability: z.boolean(),
  mandatoryCommitment: z.boolean(),
  compensation,
};

const changesSchema = z
  .strictObject(draftFields)
  .partial()
  .refine((c) => Object.keys(c).length > 0, { message: 'Change at least one field.' });

const createBody = z.strictObject(draftFields).partial().required({ title: true });

const patchBody = z.strictObject({
  expectedVersion: z.number().int().min(0),
  changes: changesSchema,
});

const publishBody = z.strictObject({ expectedVersion: z.number().int().min(0) });
const closeBody = z.strictObject({ reason: text(0, L.closeReasonMax, 'Reason') });
const emptyBody = z.strictObject({});

const listQuery = z.strictObject({
  scope: z.enum(['mine', 'discover'], { error: 'Use scope=mine or scope=discover.' }),
  ...pageQuery,
});

const idParams = z.strictObject({ id: z.string() });

/** A malformed id is indistinguishable from an unknown one (no existence probing). */
function briefId(raw: string): string {
  if (!objectIdString.safeParse(raw).success) {
    throw new AppError('NOT_FOUND', 'The requested resource was not found.');
  }
  return raw;
}

const newId = () => new mongoose.Types.ObjectId().toHexString();

/** Section 18 brief routes. All require a signed-in session (deny-by-default in v1). */
export function createBriefRouter(briefs: BriefService, idempotency: IdempotencyStore): Router {
  const router = Router();

  router.get(
    '/startups',
    withValidation({ query: listQuery }, async ({ query }, req, res) => {
      const user = currentUser(req);
      const page = pageRequest(query);
      const needed = query.scope === 'mine' ? 'founder' : 'candidate';
      if (!user.roles.includes(needed)) {
        throw new AppError('FORBIDDEN', 'Your account does not have access to this area.');
      }
      if (query.scope === 'mine') {
        const result = await briefs.listMine(user, page);
        sendList(res, result.items, encodeCursor(result.next));
      } else {
        const result = await briefs.discover(user, page);
        sendList(res, result.items, encodeCursor(result.next));
      }
    }),
  );

  router.post(
    '/startups',
    requireRole('founder'),
    withValidation({ body: createBody }, async ({ body }, req, res) => {
      const user = currentUser(req);
      const outcome = await runIdempotent({
        store: idempotency,
        req,
        actor: user,
        route: 'POST /startups',
        body,
        resourceId: newId(),
        execute: async (id) => ({
          status: 201,
          data: await briefs.create(user, id, { ...emptyBriefDraft(), ...body }),
        }),
        replay: (id) => briefs.getOwned(user, id),
      });
      sendData(res, outcome.data, outcome.status);
    }),
  );

  router.get(
    '/startups/:id',
    withValidation({ params: idParams }, async ({ params }, req, res) => {
      sendData(res, await briefs.get(currentUser(req), briefId(params.id)));
    }),
  );

  router.patch(
    '/startups/:id',
    requireRole('founder'),
    withValidation({ params: idParams, body: patchBody }, async ({ params, body }, req, res) => {
      const id = briefId(params.id);
      sendData(res, await briefs.patch(currentUser(req), id, body.expectedVersion, body.changes));
    }),
  );

  const transition = (
    action: 'publish' | 'close' | 'clone',
    schema: z.ZodType<Record<string, unknown>>,
    run: (
      user: ReturnType<typeof currentUser>,
      id: string,
      body: Record<string, unknown>,
      resourceId: string,
    ) => Promise<{ status: number; data: unknown }>,
  ) =>
    router.post(
      `/startups/:id/${action}`,
      requireRole('founder'),
      withValidation({ params: idParams, body: schema }, async ({ params, body }, req, res) => {
        const user = currentUser(req);
        const id = briefId(params.id);
        const resourceId = action === 'clone' ? newId() : id;
        const outcome = await runIdempotent({
          store: idempotency,
          req,
          actor: user,
          route: `POST /startups/${id}/${action}`,
          body,
          resourceId,
          execute: (rid) => run(user, id, body, rid),
          replay: (rid) => briefs.getOwned(user, rid),
        });
        sendData(res, outcome.data, outcome.status);
      }),
    );

  transition('publish', publishBody, async (user, id, body) => ({
    status: 200,
    data: await briefs.publish(user, id, (body as z.infer<typeof publishBody>).expectedVersion),
  }));
  transition('close', closeBody, async (user, id, body) => ({
    status: 200,
    data: await briefs.close(user, id, (body as z.infer<typeof closeBody>).reason),
  }));
  transition('clone', emptyBody, async (user, id, _body, newBriefId) => ({
    status: 201,
    data: await briefs.clone(user, id, newBriefId),
  }));

  return router;
}
