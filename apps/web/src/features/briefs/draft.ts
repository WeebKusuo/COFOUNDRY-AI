import {
  BRIEF_LIMITS as L,
  BRIEF_WRITABLE_FIELDS,
  SKILL_IDS,
  briefPublishGaps,
  hasSkillGap,
  teamLevelFor,
  type BriefDraftFields,
  type BriefPublishGap,
  type CompensationType,
  type IndustryTag,
  type MissionTag,
  type SkillId,
  type StartupBriefData,
} from '@cofoundry/shared';

/**
 * Client-side editing model for a brief draft. The server re-validates everything; these checks
 * only give earlier feedback with the same limits (shared constants and the shared publish
 * validator).
 */

export interface RequiredSkillDraft {
  key: string;
  skillId: SkillId | '';
  level: number;
  importance: number;
  mandatory: boolean;
}

export interface BriefForm {
  title: string;
  teaser: string;
  problem: string;
  solution: string;
  industryTags: IndustryTag[];
  missionTags: MissionTag[];
  requiredSkills: RequiredSkillDraft[];
  /** Founder-declared team coverage 0-5 per canonical skill (0 = none). */
  teamLevels: Record<SkillId, number>;
  hours: string;
  months: string;
  mandatoryAvailability: boolean;
  mandatoryCommitment: boolean;
  compensationType: CompensationType;
  /** Rupees as typed, e.g. "2000" or "2,000.50"; stored as integer paise. */
  amountRupees: string;
  paymentDueDays: string;
  methodNote: string;
  benefitDescription: string;
}

let keySeq = 0;
export const newKey = () => `b${(keySeq += 1)}`;

export function newRequiredSkill(): RequiredSkillDraft {
  return { key: newKey(), skillId: '', level: 3, importance: 3, mandatory: false };
}

function rupeesFromPaise(amountMinor: number | null): string {
  if (amountMinor === null) return '';
  const rupees = amountMinor / 100;
  return Number.isInteger(rupees) ? String(rupees) : rupees.toFixed(2);
}

/** "2,000.50" -> 200050; null for empty; NaN for anything that is not a valid amount. */
export function paiseFromRupees(input: string): number | null {
  const cleaned = input.replace(/[,\s₹]/g, '');
  if (cleaned === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return Number.NaN;
  return Math.round(Number(cleaned) * 100);
}

export function formFromBrief(b: StartupBriefData): BriefForm {
  const teamLevels = Object.fromEntries(
    SKILL_IDS.map((id) => [id, teamLevelFor(b.teamSkills, id)]),
  ) as Record<SkillId, number>;
  return {
    title: b.title,
    teaser: b.teaser,
    problem: b.problem,
    solution: b.solution,
    industryTags: [...b.industryTags],
    missionTags: [...b.missionTags],
    requiredSkills: b.requiredSkills.map((s) => ({ key: newKey(), ...s })),
    teamLevels,
    hours: b.hoursRequiredPerWeek === null ? '' : String(b.hoursRequiredPerWeek),
    months: b.commitmentMonths === null ? '' : String(b.commitmentMonths),
    mandatoryAvailability: b.mandatoryAvailability,
    mandatoryCommitment: b.mandatoryCommitment,
    compensationType: b.compensation.type,
    amountRupees: rupeesFromPaise(b.compensation.amountMinor),
    paymentDueDays:
      b.compensation.paymentDueDays === null ? '' : String(b.compensation.paymentDueDays),
    methodNote: b.compensation.methodNote,
    benefitDescription: b.compensation.benefitDescription,
  };
}

const intOrNull = (s: string): number | null => {
  const t = s.trim();
  if (t === '') return null;
  return /^\d+$/.test(t) ? Number(t) : Number.NaN;
};

/** The writable fields the form currently represents (invalid numbers become NaN). */
export function fieldsFromForm(f: BriefForm): BriefDraftFields {
  return {
    title: f.title,
    teaser: f.teaser,
    problem: f.problem,
    solution: f.solution,
    industryTags: [...f.industryTags],
    missionTags: [...f.missionTags],
    teamSkills: SKILL_IDS.filter((id) => f.teamLevels[id] > 0).map((id) => ({
      skillId: id,
      level: f.teamLevels[id],
    })),
    requiredSkills: f.requiredSkills
      .filter((s): s is RequiredSkillDraft & { skillId: SkillId } => s.skillId !== '')
      .map(({ skillId, level, importance, mandatory }) => ({
        skillId,
        level,
        importance,
        mandatory,
      })),
    hoursRequiredPerWeek: intOrNull(f.hours),
    commitmentMonths: intOrNull(f.months),
    mandatoryAvailability: f.mandatoryAvailability,
    mandatoryCommitment: f.mandatoryCommitment,
    compensation: {
      type: f.compensationType,
      amountMinor: paiseFromRupees(f.amountRupees),
      paymentDueDays: intOrNull(f.paymentDueDays),
      methodNote: f.methodNote,
      benefitDescription: f.benefitDescription,
    },
  };
}

/** Only the fields that differ from the saved version (PATCH sends changes, Section 18). */
export function changedFields(
  saved: BriefDraftFields,
  current: BriefDraftFields,
): Partial<BriefDraftFields> {
  const out: Partial<BriefDraftFields> = {};
  for (const key of BRIEF_WRITABLE_FIELDS) {
    if (JSON.stringify(saved[key]) !== JSON.stringify(current[key])) {
      (out as Record<string, unknown>)[key] = current[key];
    }
  }
  return out;
}

const chars = (s: string) => Array.from(s.normalize('NFKC').trim()).length;

/**
 * Draft-save checks: maximum lengths, number ranges and duplicates. Minimum lengths are only
 * required for publishing. Keys match the server's field paths (body.changes.<field>).
 */
export function validateForm(f: BriefForm): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  const add = (field: string, message: string) =>
    (errors[`body.changes.${field}`] ??= []).push(message);
  if (chars(f.title) < 1) add('title', 'Title is required.');
  if (chars(f.title) > L.titleMax) add('title', `Use at most ${L.titleMax} characters.`);
  if (chars(f.teaser) > L.teaserMax) add('teaser', `Use at most ${L.teaserMax} characters.`);
  if (chars(f.problem) > L.problemMax) add('problem', `Use at most ${L.problemMax} characters.`);
  if (chars(f.solution) > L.solutionMax)
    add('solution', `Use at most ${L.solutionMax} characters.`);
  const range = (field: string, value: string, min: number, max: number, unit: string) => {
    const n = intOrNull(value);
    if (n !== null && (Number.isNaN(n) || n < min || n > max)) {
      add(field, `Use ${min}-${max} ${unit}.`);
    }
  };
  range('hoursRequiredPerWeek', f.hours, L.hoursMin, L.hoursMax, 'hours');
  range('commitmentMonths', f.months, L.monthsMin, L.monthsMax, 'months');
  f.requiredSkills.forEach((s, i) => {
    if (s.skillId === '') add(`requiredSkills.${i}.skillId`, 'Choose a skill or remove this row.');
  });
  const ids = f.requiredSkills.map((s) => s.skillId).filter(Boolean);
  if (new Set(ids).size !== ids.length) add('requiredSkills', 'Remove duplicate required skills.');
  if (f.compensationType === 'paid') {
    const amount = paiseFromRupees(f.amountRupees);
    if (amount !== null && (Number.isNaN(amount) || amount < 1)) {
      add('compensation.amountMinor', 'Enter an amount in rupees, e.g. 2000 or 2000.50.');
    }
    range(
      'compensation.paymentDueDays',
      f.paymentDueDays,
      L.paymentDueDaysMin,
      L.paymentDueDaysMax,
      'days',
    );
  }
  if (chars(f.methodNote) > L.methodNoteMax) {
    add('compensation.methodNote', `Use at most ${L.methodNoteMax} characters.`);
  }
  if (chars(f.benefitDescription) > L.benefitDescriptionMax) {
    add('compensation.benefitDescription', `Use at most ${L.benefitDescriptionMax} characters.`);
  }
  return errors;
}

/** Publish readiness from the shared validator, for the checklist shown before publishing. */
export function publishReadiness(fields: BriefDraftFields): {
  gaps: BriefPublishGap[];
  skillGap: boolean;
} {
  const normalized: BriefDraftFields = {
    ...fields,
    title: fields.title.normalize('NFKC').trim(),
    teaser: fields.teaser.normalize('NFKC').trim(),
    problem: fields.problem.normalize('NFKC').trim(),
    solution: fields.solution.normalize('NFKC').trim(),
  };
  return { gaps: briefPublishGaps(normalized), skillGap: hasSkillGap(normalized) };
}

/** First error message for a field, from client checks, PATCH errors or publish errors. */
export function errorFor(errors: Record<string, string[]>, field: string): string | undefined {
  return (
    errors[`body.changes.${field}`]?.[0] ??
    errors[`brief.${field}`]?.[0] ??
    errors[`body.${field}`]?.[0]
  );
}
