import { redactContactDetails } from './resume.js';

/**
 * Best-effort minimisation of personal and secret data before text is sent to a third-party AI
 * provider (Phase 9). This is NOT anonymisation and does not guarantee that all personal data is
 * removed: names in free text, addresses without labels and unusual identifiers can remain.
 * Callers must still send no identity fields (ids, email, account data) alongside the text.
 *
 * Deterministic, no network access, every quantifier bounded (linear on hostile input).
 */

export interface AiRedactionCounts {
  emails: number;
  phones: number;
  urls: number;
  credentials: number;
  governmentIds: number;
  names: number;
  labelledPersonalFields: number;
}

const PRIVATE_KEY =
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,10000}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g;
const CONNECTION_CREDENTIALS = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,100}:[^\s@/]{1,200}@/gi;
const AWS_KEY = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const PREFIXED_TOKEN =
  /\b(?:sk|pk|rk|gsk|ghp|gho|ghu|ghs|github_pat|glpat|xox[abposr])[-_][A-Za-z0-9_-]{16,200}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,2000}\.[A-Za-z0-9_-]{8,2000}\.[A-Za-z0-9_-]{8,2000}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]{16,2000}=*/gi;
const SECRET_ASSIGNMENT =
  /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token)(\s{0,5}[:=]\s{0,5})(["']?)[^\s"']{4,200}\3/gi;

const AADHAAR = /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g;
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

const LABELLED_FIELD =
  /^([ \t]{0,20}(?:full name|name|address|home address|date of birth|dob|birth date|nationality|gender|marital status|religion|father'?s name|mother'?s name)[ \t]{0,5}[:-][ \t]{0,5})[^\n]{1,300}$/gim;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Names known to belong to the participants (e.g. the account display name). Full multi-word
 * names are removed case-insensitively; single words only when written with the same
 * capitalisation and at least 3 letters long, so ordinary technical words ("dev", "node") are not
 * damaged.
 */
function nameMatchers(knownNames: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  const seen = new Set<string>();
  for (const raw of knownNames) {
    const name = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 120) continue;
    const parts = name.split(' ');
    if (parts.length > 1 && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu'));
    }
    for (const part of parts) {
      if (part.length < 3 || seen.has(part)) continue;
      seen.add(part);
      out.push(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(part)}(?![\\p{L}\\p{N}])`, 'gu'));
    }
  }
  return out;
}

export function redactForAi(
  text: string,
  options: { knownNames?: readonly string[] } = {},
): { text: string; counts: AiRedactionCounts } {
  const counts: AiRedactionCounts = {
    emails: 0,
    phones: 0,
    urls: 0,
    credentials: 0,
    governmentIds: 0,
    names: 0,
    labelledPersonalFields: 0,
  };
  const credential =
    (label = '[credential removed]') =>
    () => {
      counts.credentials += 1;
      return label;
    };
  let out = text.replace(PRIVATE_KEY, credential('[private key removed]'));
  out = out.replace(CONNECTION_CREDENTIALS, (m) => {
    counts.credentials += 1;
    return `${m.slice(0, m.indexOf('://') + 3)}[credentials removed]@`;
  });
  out = out
    .replace(AWS_KEY, credential())
    .replace(PREFIXED_TOKEN, credential())
    .replace(JWT, credential())
    .replace(BEARER, credential('Bearer [credential removed]'));
  out = out.replace(SECRET_ASSIGNMENT, (_m, label: string, sep: string) => {
    counts.credentials += 1;
    return `${label}${sep}[credential removed]`;
  });
  const gov = () => {
    counts.governmentIds += 1;
    return '[id removed]';
  };
  out = out.replace(PAN, gov).replace(SSN, gov).replace(AADHAAR, gov);
  out = out.replace(LABELLED_FIELD, (_m, label: string) => {
    counts.labelledPersonalFields += 1;
    return `${label}[removed]`;
  });
  const contact = redactContactDetails(out);
  out = contact.text;
  counts.emails = contact.redactions.emails;
  counts.phones = contact.redactions.phones;
  counts.urls = contact.redactions.urls;
  for (const re of nameMatchers(options.knownNames ?? [])) {
    out = out.replace(re, () => {
      counts.names += 1;
      return '[name]';
    });
  }
  return { text: out, counts };
}

const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^\n]{0,40}\b(?:previous|prior|above|earlier|all|system|your)\b[^\n]{0,40}\b(?:instructions?|prompts?|rules?|guidelines?)\b/i,
  /\b(?:system|developer|hidden)\s+(?:prompt|message|instructions?)\b/i,
  /\byou\s+are\s+(?:now\s+)?(?:an?|the|my)\s+(?:ai|assistant|evaluator|grader|interviewer|model)\b/i,
  /\b(?:give|award|assign|rate|score)\b[^\n]{0,30}\b(?:full|maximum|max|perfect|top|highest)\s+(?:score|marks?|points?|rating)\b/i,
  /<\/?\s*(?:system|instructions?|assistant|developer)\s*>/i,
  /\b(?:jailbreak|prompt\s+injection)\b/i,
  /\breturn\s+(?:only\s+)?(?:the\s+)?json\b[^\n]{0,40}\b(?:score|level)s?\b[^\n]{0,20}\b4\b/i,
];

/** Flags text that looks like instructions to the AI. Detection is heuristic and never blocks. */
export function looksLikePromptInjection(text: string): boolean {
  const sample = text.length > 20_000 ? text.slice(0, 20_000) : text;
  return INJECTION_PATTERNS.some((re) => re.test(sample));
}
