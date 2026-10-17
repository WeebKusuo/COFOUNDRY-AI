import type { OPPORTUNITY_TYPE, ROLE_KEY, VERSIONS, WORK_MODE } from './constants.js';
import { CURRENCY, type IndustryTag, type MissionTag, type SkillId } from './constants.js';

/**
 * Startup brief contracts (Sections 03, 06, 13, 14, 18).
 *
 * A brief moves draft -> open -> closed. Only its founder edits a draft; publishing validates
 * every required field and snapshots the draft as version 1. Published briefs are immutable —
 * changing terms means cloning into a new draft. Problem and solution are the confidential "full
 * idea": they are never part of the teaser projection.
 */

export const BRIEF_STATUSES = ['draft', 'open', 'closed'] as const;
export type BriefStatus = (typeof BRIEF_STATUSES)[number];

export const BRIEF_LIMITS = {
  titleMax: 100,
  teaserMin: 50,
  teaserMax: 500,
  problemMin: 50,
  problemMax: 3000,
  solutionMin: 50,
  solutionMax: 3000,
  interestTagsMin: 1,
  interestTagsMax: 5,
  requiredSkillsMin: 1,
  requiredSkillsMax: 8,
  requiredLevelMin: 1,
  requiredLevelMax: 5,
  importanceMin: 1,
  importanceMax: 5,
  teamLevelMin: 0,
  teamLevelMax: 5,
  hoursMin: 1,
  hoursMax: 40,
  monthsMin: 1,
  monthsMax: 12,
  closeReasonMax: 500,
  paymentDueDaysMin: 1,
  paymentDueDaysMax: 30,
  methodNoteMax: 300,
  benefitDescriptionMin: 20,
  benefitDescriptionMax: 500,
} as const;

/** Section 13: the trial cap is a policy constant, not founder-adjustable. */
export const TRIAL_CAP_HOURS = 10;

export const COMPENSATION_TYPES = ['paid', 'credit_reference', 'unpaid'] as const;
export type CompensationType = (typeof COMPENSATION_TYPES)[number];

export const COMPENSATION_TYPE_LABELS: Readonly<Record<CompensationType, string>> = {
  paid: 'Paid',
  credit_reference: 'Credit or reference',
  unpaid: 'Unpaid',
};

/** Section 13: fixed creator-owned IP default (ipPolicyVersion creator-owned-v3.0). */
export const IP_POLICY_NOTICE =
  'You retain ownership of what you create. The founder may evaluate the submission but has no ' +
  'permission from this platform to use it in production. Any transfer, production licence or ' +
  'different arrangement must be agreed separately in writing.';

/** Section 13: shown for credit/reference and unpaid terms. */
export const NO_MONETARY_PAYMENT_NOTICE = 'No monetary payment promised';

/** Section 01: payments are off-platform; terms are recorded, never processed or verified. */
export const EXTERNAL_PAYMENT_NOTICE =
  'Payments happen outside CoFoundry. The platform records the promised terms only; it does not ' +
  'process or verify payments.';

/** Section 06: the full-brief acknowledgement (conf-v3.0). Used when access grants arrive. */
export const CONFIDENTIALITY_NOTICE =
  'This acknowledgement is not a signed NDA. Do not disclose secrets; arrange any legal ' +
  'agreement separately.';

/**
 * Compensation as stored on a draft. Paid is preselected, but every paid detail must be completed
 * explicitly before publication; fields that do not belong to the chosen type are cleared on
 * publish so the published record is unambiguous.
 */
export interface CompensationDraft {
  type: CompensationType;
  amountMinor: number | null;
  paymentDueDays: number | null;
  methodNote: string;
  benefitDescription: string;
}

/** Complete, validated terms (published briefs; later request/sprint snapshots). */
export type CompensationTerms =
  | {
      type: 'paid';
      amountMinor: number;
      currency: typeof CURRENCY;
      payer: 'founder';
      paymentDueDays: number;
      methodNote: string;
    }
  | { type: 'credit_reference'; benefitDescription: string }
  | { type: 'unpaid' };

export const DEFAULT_COMPENSATION: CompensationDraft = Object.freeze({
  type: 'paid',
  amountMinor: null,
  paymentDueDays: null,
  methodNote: '',
  benefitDescription: '',
}) as CompensationDraft;

export interface TeamSkill {
  skillId: SkillId;
  /** Founder-declared coverage 0-5; not computed from teammates. Missing skill = 0. */
  level: number;
}

export interface RequiredSkill {
  skillId: SkillId;
  level: number;
  importance: number;
  mandatory: boolean;
}

/** Writable draft fields (PATCH changes / POST create). Server fields are never accepted. */
export interface BriefDraftFields {
  title: string;
  teaser: string;
  problem: string;
  solution: string;
  industryTags: IndustryTag[];
  missionTags: MissionTag[];
  teamSkills: TeamSkill[];
  requiredSkills: RequiredSkill[];
  hoursRequiredPerWeek: number | null;
  commitmentMonths: number | null;
  mandatoryAvailability: boolean;
  mandatoryCommitment: boolean;
  compensation: CompensationDraft;
}

export const BRIEF_WRITABLE_FIELDS = [
  'title',
  'teaser',
  'problem',
  'solution',
  'industryTags',
  'missionTags',
  'teamSkills',
  'requiredSkills',
  'hoursRequiredPerWeek',
  'commitmentMonths',
  'mandatoryAvailability',
  'mandatoryCommitment',
  'compensation',
] as const satisfies ReadonlyArray<keyof BriefDraftFields>;

/** Owner projection (GET /startups/:id for the founder): every stored field except internals. */
export interface StartupBriefData extends BriefDraftFields {
  id: string;
  status: BriefStatus;
  /** Draft: starts at 0 and increments on each edit. Published: 1. */
  version: number;
  roleKey: typeof ROLE_KEY;
  opportunityType: typeof OPPORTUNITY_TYPE;
  workMode: typeof WORK_MODE;
  ipPolicyVersion: typeof VERSIONS.ipPolicy;
  publishedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  clonedFromId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** GET /startups?scope=mine list entry. */
export interface BriefOwnerSummary {
  id: string;
  status: BriefStatus;
  version: number;
  title: string;
  teaser: string;
  publishedAt: string | null;
  closedAt: string | null;
  clonedFromId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Section 06 teaser projection — what an authenticated candidate sees before acknowledging
 * confidentiality. Never contains problem, solution, team coverage or founder account fields.
 */
export interface BriefPreview {
  id: string;
  status: BriefStatus;
  version: number;
  title: string;
  teaser: string;
  roleKey: typeof ROLE_KEY;
  opportunityType: typeof OPPORTUNITY_TYPE;
  workMode: typeof WORK_MODE;
  requiredSkills: RequiredSkill[];
  hoursRequiredPerWeek: number | null;
  commitmentMonths: number | null;
  /** Null only while a draft's terms are incomplete (owner preview). */
  compensation: CompensationTerms | null;
  ipPolicyVersion: typeof VERSIONS.ipPolicy;
  trialCapHours: number;
  founder: {
    displayName: string;
    demoAccount: boolean;
    /** Self-reported link from the founder profile; never verified. */
    companyUrl: string | null;
    /** Computed from completed sprint records ("completed trials"), never editable. */
    completedSprintCount: number;
  };
  publishedAt: string | null;
}

/** GET /startups/:id — the server decides which projection the viewer may see. */
export type BriefView =
  | { access: 'owner'; brief: StartupBriefData; preview: BriefPreview }
  | { access: 'preview'; preview: BriefPreview };

export interface BriefCreateRequest extends Partial<BriefDraftFields> {
  title: string;
}

export interface BriefPatchRequest {
  expectedVersion: number;
  changes: Partial<BriefDraftFields>;
}

export interface BriefPublishRequest {
  expectedVersion: number;
}

export interface BriefCloseRequest {
  reason: string;
}

/** Empty draft content for a new brief (title is the only required create field). */
export function emptyBriefDraft(title = ''): BriefDraftFields {
  return {
    title,
    teaser: '',
    problem: '',
    solution: '',
    industryTags: [],
    missionTags: [],
    teamSkills: [],
    requiredSkills: [],
    hoursRequiredPerWeek: null,
    commitmentMonths: null,
    mandatoryAvailability: false,
    mandatoryCommitment: false,
    compensation: { ...DEFAULT_COMPENSATION },
  };
}

function chars(value: string): number {
  return Array.from(value).length;
}

/** Field path (relative to the brief) -> message, for one unmet publish requirement. */
export interface BriefPublishGap {
  field: string;
  message: string;
}

/** Validated compensation terms, or null when the draft is incomplete for its type. */
export function toCompensationTerms(c: CompensationDraft): CompensationTerms | null {
  return compensationGaps(c).length > 0 ? null : normalizedCompensation(c);
}

function normalizedCompensation(c: CompensationDraft): CompensationTerms {
  switch (c.type) {
    case 'paid':
      return {
        type: 'paid',
        amountMinor: c.amountMinor ?? 0,
        currency: CURRENCY,
        payer: 'founder',
        paymentDueDays: c.paymentDueDays ?? 0,
        methodNote: c.methodNote,
      };
    case 'credit_reference':
      return { type: 'credit_reference', benefitDescription: c.benefitDescription };
    case 'unpaid':
      return { type: 'unpaid' };
  }
}

/** The stored draft shape of validated terms: irrelevant fields cleared. */
export function compensationDraftFromTerms(t: CompensationTerms): CompensationDraft {
  return {
    type: t.type,
    amountMinor: t.type === 'paid' ? t.amountMinor : null,
    paymentDueDays: t.type === 'paid' ? t.paymentDueDays : null,
    methodNote: t.type === 'paid' ? t.methodNote : '',
    benefitDescription: t.type === 'credit_reference' ? t.benefitDescription : '',
  };
}

function compensationGaps(c: CompensationDraft): BriefPublishGap[] {
  const L = BRIEF_LIMITS;
  const gaps: BriefPublishGap[] = [];
  if (c.type === 'paid') {
    if (c.amountMinor === null || !Number.isSafeInteger(c.amountMinor) || c.amountMinor < 1) {
      gaps.push({ field: 'compensation.amountMinor', message: 'Enter the amount in INR.' });
    }
    if (
      c.paymentDueDays === null ||
      c.paymentDueDays < L.paymentDueDaysMin ||
      c.paymentDueDays > L.paymentDueDaysMax
    ) {
      gaps.push({
        field: 'compensation.paymentDueDays',
        message: `Set payment due ${L.paymentDueDaysMin}-${L.paymentDueDaysMax} days after submission.`,
      });
    }
    const note = chars(c.methodNote);
    if (note < 1 || note > L.methodNoteMax) {
      gaps.push({ field: 'compensation.methodNote', message: 'Describe how you will pay.' });
    }
  } else if (c.type === 'credit_reference') {
    const n = chars(c.benefitDescription);
    if (n < L.benefitDescriptionMin || n > L.benefitDescriptionMax) {
      gaps.push({
        field: 'compensation.benefitDescription',
        message: `Describe the credit or reference in ${L.benefitDescriptionMin}-${L.benefitDescriptionMax} characters.`,
      });
    }
  }
  return gaps;
}

/** Section 03: team coverage for a skill; a missing entry means level 0. */
export function teamLevelFor(teamSkills: readonly TeamSkill[], skillId: SkillId): number {
  return teamSkills.find((s) => s.skillId === skillId)?.level ?? 0;
}

/** Section 03: at least one required skill must exceed the team's declared coverage. */
export function hasSkillGap(
  brief: Pick<BriefDraftFields, 'requiredSkills' | 'teamSkills'>,
): boolean {
  return brief.requiredSkills.some((r) => r.level > teamLevelFor(brief.teamSkills, r.skillId));
}

/**
 * Publish validator (Sections 03, 06, 13). Returns every unmet requirement except the skill gap,
 * which is reported separately as NO_SKILL_GAP once everything else is complete.
 */
export function briefPublishGaps(brief: BriefDraftFields): BriefPublishGap[] {
  const L = BRIEF_LIMITS;
  const gaps: BriefPublishGap[] = [];
  const range = (field: keyof BriefDraftFields, value: string, min: number, max: number) => {
    const n = chars(value);
    if (n < min || n > max) {
      gaps.push({ field, message: `Use ${min}-${max.toLocaleString('en-IN')} characters.` });
    }
  };
  if (chars(brief.title) < 1 || chars(brief.title) > L.titleMax) {
    gaps.push({ field: 'title', message: 'Add a title.' });
  }
  range('teaser', brief.teaser, L.teaserMin, L.teaserMax);
  range('problem', brief.problem, L.problemMin, L.problemMax);
  range('solution', brief.solution, L.solutionMin, L.solutionMax);
  if (brief.industryTags.length < L.interestTagsMin) {
    gaps.push({ field: 'industryTags', message: 'Choose at least one industry.' });
  }
  if (brief.missionTags.length < L.interestTagsMin) {
    gaps.push({ field: 'missionTags', message: 'Choose at least one mission.' });
  }
  if (brief.requiredSkills.length < L.requiredSkillsMin) {
    gaps.push({ field: 'requiredSkills', message: 'Add at least one required skill.' });
  }
  if (brief.hoursRequiredPerWeek === null) {
    gaps.push({ field: 'hoursRequiredPerWeek', message: 'Set the weekly hours you need.' });
  }
  if (brief.commitmentMonths === null) {
    gaps.push({ field: 'commitmentMonths', message: 'Set the commitment in months.' });
  }
  gaps.push(...compensationGaps(brief.compensation));
  return gaps;
}

export const NO_SKILL_GAP_MESSAGE =
  'At least one required skill must be above your team’s current level.';

/** Display amount for integer minor units (INR paise). */
export function formatInr(amountMinor: number): string {
  const rupees = amountMinor / 100;
  return `₹${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Human-readable one-line summary of terms, e.g. for previews and cards. */
export function compensationSummary(terms: CompensationTerms): string {
  switch (terms.type) {
    case 'paid':
      return `Paid · ${formatInr(terms.amountMinor)} within ${terms.paymentDueDays} days of submission`;
    case 'credit_reference':
      return `Credit or reference · ${NO_MONETARY_PAYMENT_NOTICE}`;
    case 'unpaid':
      return `Unpaid · ${NO_MONETARY_PAYMENT_NOTICE}`;
  }
}
