import { describe, expect, it } from 'vitest';
import {
  briefPublishGaps,
  compensationDraftFromTerms,
  compensationSummary,
  emptyBriefDraft,
  formatInr,
  hasSkillGap,
  redactContactDetails,
  resumeInterviewReadiness,
  sanitizeResumeFilename,
  toCompensationTerms,
  type BriefDraftFields,
  type CandidateResumeData,
} from '../src/index.js';

const LONG = 'x'.repeat(60);

function complete(overrides: Partial<BriefDraftFields> = {}): BriefDraftFields {
  return {
    ...emptyBriefDraft('PayPilot'),
    teaser: LONG,
    problem: LONG,
    solution: LONG,
    industryTags: ['fintech'],
    missionTags: ['reliability'],
    teamSkills: [{ skillId: 'nodejs', level: 2 }],
    requiredSkills: [{ skillId: 'nodejs', level: 4, importance: 2, mandatory: false }],
    hoursRequiredPerWeek: 8,
    commitmentMonths: 3,
    compensation: {
      type: 'paid',
      amountMinor: 200_000,
      paymentDueDays: 7,
      methodNote: 'UPI',
      benefitDescription: '',
    },
    ...overrides,
  };
}

describe('brief publish rules', () => {
  it('accepts a complete brief and lists every gap of an empty one', () => {
    expect(briefPublishGaps(complete())).toEqual([]);
    expect(briefPublishGaps(emptyBriefDraft('T')).map((g) => g.field)).toEqual([
      'teaser',
      'problem',
      'solution',
      'industryTags',
      'missionTags',
      'requiredSkills',
      'hoursRequiredPerWeek',
      'commitmentMonths',
      'compensation.amountMinor',
      'compensation.paymentDueDays',
      'compensation.methodNote',
    ]);
  });

  it('checks length boundaries in code points', () => {
    expect(briefPublishGaps(complete({ teaser: 'é'.repeat(50) }))).toEqual([]);
    expect(briefPublishGaps(complete({ teaser: 'x'.repeat(49) })).map((g) => g.field)).toEqual([
      'teaser',
    ]);
    expect(briefPublishGaps(complete({ teaser: 'x'.repeat(501) })).map((g) => g.field)).toEqual([
      'teaser',
    ]);
    expect(briefPublishGaps(complete({ problem: 'x'.repeat(3000) }))).toEqual([]);
  });

  it('requires type-specific compensation details', () => {
    const credit = complete({
      compensation: {
        type: 'credit_reference',
        amountMinor: null,
        paymentDueDays: null,
        methodNote: '',
        benefitDescription: 'too short',
      },
    });
    expect(briefPublishGaps(credit).map((g) => g.field)).toEqual([
      'compensation.benefitDescription',
    ]);
    const unpaid = complete({
      compensation: {
        type: 'unpaid',
        amountMinor: null,
        paymentDueDays: null,
        methodNote: '',
        benefitDescription: '',
      },
    });
    expect(briefPublishGaps(unpaid)).toEqual([]);
    expect(toCompensationTerms(unpaid.compensation)).toEqual({ type: 'unpaid' });
    expect(toCompensationTerms(complete().compensation)).toEqual({
      type: 'paid',
      amountMinor: 200_000,
      currency: 'INR',
      payer: 'founder',
      paymentDueDays: 7,
      methodNote: 'UPI',
    });
    expect(toCompensationTerms(emptyBriefDraft().compensation)).toBeNull();
    expect(
      compensationDraftFromTerms({ type: 'credit_reference', benefitDescription: 'b' }),
    ).toEqual({
      type: 'credit_reference',
      amountMinor: null,
      paymentDueDays: null,
      methodNote: '',
      benefitDescription: 'b',
    });
  });

  it('needs at least one required skill above team coverage (missing team skill = 0)', () => {
    expect(hasSkillGap(complete())).toBe(true);
    expect(hasSkillGap(complete({ teamSkills: [{ skillId: 'nodejs', level: 4 }] }))).toBe(false);
    expect(
      hasSkillGap(
        complete({
          teamSkills: [{ skillId: 'nodejs', level: 5 }],
          requiredSkills: [
            { skillId: 'nodejs', level: 4, importance: 2, mandatory: false },
            { skillId: 'rest-api', level: 1, importance: 1, mandatory: true },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('formats INR minor units', () => {
    expect(formatInr(200_000)).toBe('₹2,000');
    expect(formatInr(12_345_678)).toBe('₹1,23,456.78');
    expect(compensationSummary({ type: 'unpaid' })).toContain('No monetary payment promised');
  });
});

describe('resume helpers', () => {
  it('redacts emails, phone numbers and links but keeps ordinary numbers', () => {
    const r = redactContactDetails(
      'Mail a.b+c@mail.example.co.in, call +91-98765-43210, see https://x.dev/me?a=1 and www.site.io. Led 12 people in 2021; ID 12345.',
    );
    expect(r.text).toBe(
      'Mail [email removed], call [phone removed], see [link removed] and [link removed]. Led 12 people in 2021; ID 12345.',
    );
    expect(r.redactions).toEqual({ emails: 1, phones: 1, urls: 2 });
  });

  it('redacts links written without a scheme but keeps technology names', () => {
    const r = redactContactDetails(
      'See linkedin.com/in/jane-doe, github.com/janedoe and portfolio.dev/work. Built with Node.js/Express and Vue.js. Profile: github.com',
    );
    expect(r.text).toBe(
      'See [link removed], [link removed] and [link removed]. Built with Node.js/Express and Vue.js. Profile: [link removed]',
    );
    expect(r.redactions.urls).toBe(4);
  });

  it('redacts several phone numbers in a row and keeps adjacent years', () => {
    expect(redactContactDetails('Mobile 9876543210 9123456789').text).toBe(
      'Mobile [phone removed] [phone removed]',
    );
    expect(redactContactDetails('Phone: +91 98765 43210 2019 - 2023').text).toBe(
      'Phone: [phone removed] 2019 - 2023',
    );
  });

  it('sanitises filenames to a bounded display name ending in .pdf', () => {
    expect(sanitizeResumeFilename('C:\\Users\\me\\CV final.PDF')).toBe('CV final.pdf');
    expect(sanitizeResumeFilename('../../.hidden.pdf')).toBe('hidden.pdf');
    expect(sanitizeResumeFilename('')).toBe('resume.pdf');
    expect(sanitizeResumeFilename(null)).toBe('resume.pdf');
    expect(sanitizeResumeFilename('report.docx')).toBe('report.docx.pdf');
    expect(Array.from(sanitizeResumeFilename('a'.repeat(500))).length).toBe(120);
    // Bounded by UTF-16 length (what MongoDB validates), without splitting surrogate pairs.
    const emoji = sanitizeResumeFilename('😀'.repeat(100));
    expect(emoji.length).toBeLessThanOrEqual(120);
    expect(emoji).toBe(`${'😀'.repeat(58)}.pdf`);
  });

  it('reports interview readiness from metadata and consent', () => {
    const base: CandidateResumeData = {
      resume: null,
      currentVersion: 0,
      consent: false,
      policyVersion: 'resume-processing-v1',
    };
    expect(resumeInterviewReadiness(base)).toEqual({ ready: false, reason: 'no_resume' });
    const resume = {
      version: 3,
      filename: 'cv.pdf',
      sizeBytes: 10,
      fileSha256: 'f',
      uploadedAt: '',
      extraction: {
        status: 'succeeded' as const,
        extractorVersion: 'x',
        pageCount: 1,
        pagesProcessed: 1,
        textChars: 5,
        truncated: false,
        textSha256: 'abc',
        extractedAt: '',
      },
    };
    expect(resumeInterviewReadiness({ ...base, resume })).toEqual({
      ready: false,
      reason: 'consent_missing',
    });
    expect(resumeInterviewReadiness({ ...base, resume, consent: true })).toEqual({
      ready: true,
      version: 3,
      textSha256: 'abc',
    });
    expect(
      resumeInterviewReadiness({
        ...base,
        consent: true,
        resume: { ...resume, extraction: { ...resume.extraction, status: 'no_text' } },
      }),
    ).toEqual({ ready: false, reason: 'no_text' });
  });
});
