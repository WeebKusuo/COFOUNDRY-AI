import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  INDUSTRY_LABELS,
  INDUSTRY_TAGS,
  MISSION_LABELS,
  MISSION_TAGS,
  SKILL_LABELS,
  discoveryGaps,
  ERROR_STATUS,
  SKILL_IDS,
  checkHttpsUrl,
  isApiErrorBody,
  normalizeEmail,
  normalizeText,
  resolveSkillId,
} from '../src/index.js';

describe('constants', () => {
  it('has exactly the twelve canonical skill IDs from Section 03', () => {
    expect(SKILL_IDS).toHaveLength(12);
    expect(new Set(SKILL_IDS).size).toBe(12);
  });

  it('maps every stable error code to an HTTP status from Section 17', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
    expect(ERROR_STATUS.VALIDATION_FAILED).toBe(422);
    expect(ERROR_STATUS.CSRF_INVALID).toBe(403);
    expect(ERROR_STATUS.BODY_TOO_LARGE).toBe(413);
  });
});

describe('normalizeText', () => {
  it('trims and applies NFKC', () => {
    expect(normalizeText('  ＡＢＣ ')).toBe('ABC');
    expect(normalizeText('ﬁle')).toBe('file');
  });
});

describe('resolveSkillId', () => {
  it('accepts canonical ids and the fixed aliases case-insensitively', () => {
    expect(resolveSkillId('MongoDB')).toBe('mongodb');
    expect(resolveSkillId('Node.js')).toBe('nodejs');
    expect(resolveSkillId(' REST API ')).toBe('rest-api');
    expect(resolveSkillId('auth')).toBe('authentication');
  });

  it('rejects free text instead of guessing', () => {
    expect(resolveSkillId('nodejs developer')).toBeNull();
    expect(resolveSkillId('python')).toBeNull();
    expect(resolveSkillId('postgres')).toBeNull();
  });
});

describe('checkHttpsUrl', () => {
  it('accepts a plain https URL', () => {
    expect(checkHttpsUrl('https://github.com/example/repo')).toEqual({
      ok: true,
      url: 'https://github.com/example/repo',
    });
  });

  it.each([
    ['http://example.com', 'not_https'],
    ['https://user:pw@example.com', 'credentials'],
    ['https://example.com/a#frag', 'fragment'],
    ['https://example.com:8443/', 'port'],
    ['https://localhost/', 'local_host'],
    ['https://printer.local/', 'local_host'],
    ['https://intranet/', 'local_host'],
    ['https://127.0.0.1/', 'ip_literal'],
    ['https://[::1]/', 'ip_literal'],
    ['https://2130706433/', 'ip_literal'],
    ['https://0x7f.1/', 'ip_literal'],
    ['javascript:alert(1)', 'not_https'],
    ['not a url', 'invalid'],
  ])('rejects %s (%s)', (input, reason) => {
    expect(checkHttpsUrl(input)).toEqual({ ok: false, reason });
  });

  it('rejects URLs longer than 2,048 characters', () => {
    expect(checkHttpsUrl(`https://example.com/${'a'.repeat(2048)}`)).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });
});

describe('isApiErrorBody', () => {
  it('recognises the standard error envelope only', () => {
    expect(isApiErrorBody({ error: { code: 'NOT_FOUND', message: 'x' }, requestId: 'r' })).toBe(
      true,
    );
    expect(isApiErrorBody({ error: { code: 'MADE_UP', message: 'x' } })).toBe(false);
    expect(isApiErrorBody(null)).toBe(false);
  });
});

describe('normalizeEmail', () => {
  it('trims, lowercases and applies NFKC so one account has one key', () => {
    expect(normalizeEmail('  Founder@Demo.CoFoundry.TEST ')).toBe('founder@demo.cofoundry.test');
    expect(normalizeEmail('ｆounder@x.test')).toBe('founder@x.test');
  });
});

describe('profile contract', () => {
  const complete = {
    skills: [{ skillId: 'nodejs', level: 3 }],
    industryTags: ['fintech'],
    missionTags: ['reliability'],
    availableHoursPerWeek: 8,
    commitmentMonths: 3,
    opportunityTypes: ['contributor'],
    discoveryConsent: true,
  };

  it('is discovery-ready only with every non-project field and consent', () => {
    expect(discoveryGaps(complete)).toEqual([]);
    expect(discoveryGaps({ ...complete, skills: [], discoveryConsent: false })).toEqual([
      'skills',
      'discoveryConsent',
    ]);
    expect(
      discoveryGaps({ ...complete, availableHoursPerWeek: null, opportunityTypes: [] }),
    ).toEqual(['availableHoursPerWeek', 'opportunityTypes']);
  });

  it('labels every canonical tag', () => {
    expect(Object.keys(SKILL_LABELS).sort()).toEqual([...SKILL_IDS].sort());
    expect(Object.keys(INDUSTRY_LABELS).sort()).toEqual([...INDUSTRY_TAGS].sort());
    expect(Object.keys(MISSION_LABELS).sort()).toEqual([...MISSION_TAGS].sort());
  });
});
