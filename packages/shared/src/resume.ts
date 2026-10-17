/**
 * Candidate resume contracts (Phase 4 amendment to v3.0, which originally deferred uploads).
 *
 * A candidate may store one private PDF resume. The server validates it, extracts its text in a
 * bounded worker and keeps versioned metadata. Only the candidate can download the file; founders
 * never receive the file or its text. The extracted text — with contact details removed — is the
 * input for future resume-based interview question generation, which must check availability
 * (resumeInterviewReadiness) before starting.
 */

export const RESUME_LIMITS = {
  /** Strict upload size limit. */
  maxBytes: 5 * 1024 * 1024,
  /** Pages processed for text; later pages are ignored and the extraction is marked truncated. */
  maxPages: 10,
  /** Stored extracted text, in characters; longer text is truncated. */
  maxTextChars: 30_000,
  /** Wall-clock limit for one extraction. */
  extractionTimeoutMs: 15_000,
  filenameMax: 120,
  /** Upload/replace rate limit per candidate. */
  uploadsPerHour: 10,
} as const;

export const RESUME_CONTENT_TYPE = 'application/pdf' as const;

/** Version of the resume-processing notice the candidate consents to on upload. */
export const RESUME_POLICY_VERSION = 'resume-processing-v1' as const;

/** Header carrying the consent version on upload (the body is the PDF itself). */
export const RESUME_CONSENT_HEADER = 'X-Resume-Consent' as const;
/** Header carrying the optimistic-concurrency version on upload (0 = no resume yet). */
export const RESUME_EXPECTED_VERSION_HEADER = 'X-Expected-Version' as const;
/** Header carrying the original file name, URI-encoded. Display only — never a storage path. */
export const RESUME_FILENAME_HEADER = 'X-Filename' as const;

export const RESUME_PROCESSING_NOTICE =
  'Your resume is stored privately. Only you can download it — founders never receive the file ' +
  'or its text. CoFoundry extracts the text so a future interview you accept can ask questions ' +
  'about your experience; email addresses, phone numbers and links are removed before that ' +
  'text is used. Delete it at any time: the file and the extracted text are removed.';

/**
 * succeeded: text was extracted. no_text: the PDF opened but contains no extractable text (for
 * example a scanned image; there is no OCR), so resume-based questions are unavailable.
 * PDFs that cannot be opened (malformed, encrypted, too slow) are rejected and never stored.
 */
export const RESUME_EXTRACTION_STATUSES = ['succeeded', 'no_text'] as const;
export type ResumeExtractionStatus = (typeof RESUME_EXTRACTION_STATUSES)[number];

export interface ResumeExtraction {
  status: ResumeExtractionStatus;
  /** Extractor implementation and version, recorded for reproducibility. */
  extractorVersion: string;
  pageCount: number;
  pagesProcessed: number;
  textChars: number;
  /** True when pages or characters beyond the limits were ignored. */
  truncated: boolean;
  /** SHA-256 of the stored extracted text (hex); identifies the exact text used later. */
  textSha256: string;
  extractedAt: string;
}

export interface ResumeMetadata {
  /** Increments on every upload or replacement; never reused, even after deletion. */
  version: number;
  /** Sanitised display name. */
  filename: string;
  sizeBytes: number;
  /** SHA-256 of the uploaded file (hex). */
  fileSha256: string;
  uploadedAt: string;
  extraction: ResumeExtraction;
}

/** GET /candidate/resume (and the response to upload). */
export interface CandidateResumeData {
  resume: ResumeMetadata | null;
  /** The last version number issued (0 if never uploaded); the next upload expects it. */
  currentVersion: number;
  /** True while an active resume-processing consent record exists. */
  consent: boolean;
  policyVersion: typeof RESUME_POLICY_VERSION;
}

/** GET /candidate/resume/text — the candidate's own view of what future questions may use. */
export interface ResumeTextData {
  version: number;
  status: ResumeExtractionStatus;
  /** Extracted text after contact-detail redaction (what an interview service would receive). */
  redactedText: string;
  redactions: ContactRedactionCounts;
  truncated: boolean;
}

export interface ContactRedactionCounts {
  emails: number;
  phones: number;
  urls: number;
}

// Every quantifier is bounded so matching stays linear on hostile input (no catastrophic
// backtracking on long runs without an "@" or a separator).
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g;
const URL_LIKE = /\b(?:https?:\/\/|www\.)[^\s<>()]{1,2048}/gi;
// Links written without a scheme, e.g. "linkedin.com/in/jane" or "github.com/jane". Limited to
// common TLDs so technology names such as "Node.js/Express" are not mistaken for links.
const BARE_LINK =
  /\b(?:[a-z0-9-]{1,63}\.){1,5}(?:com|org|net|io|dev|in|co|me|ai|app|edu|gov|info|xyz|tech|site|page|uk|us|so|sh)\/[^\s<>()]{0,2048}/gi;
const PROFILE_HOSTS =
  /\b(?:linkedin\.com|github\.com|gitlab\.com|bitbucket\.org|behance\.net|dribbble\.com)\b/gi;
// A run of digits and phone separators; bounded, so matching stays linear.
const PHONE_RUN = /\+?\(?\d[\d ().-]{8,60}\d/g;

const digitCount = (s: string) => s.replace(/\D/g, '').length;

/**
 * Within one run of digits and separators, redact every whitespace-separated group of 10-15
 * digits ("+91 98765 43210"), including several numbers in a row or a number next to a year.
 * Shorter leftovers (years, ranges) are kept.
 */
function redactPhoneRun(run: string, counts: ContactRedactionCounts): string {
  if (digitCount(run) < 10) return run;
  const parts = run.split(/(\s+)/); // keep separators so the text layout survives
  const out: string[] = [];
  let i = 0;
  while (i < parts.length) {
    if (digitCount(parts[i]!) === 0) {
      out.push(parts[i]!); // a separator between numbers stays as written
      i += 1;
      continue;
    }
    let digits = 0;
    let j = i;
    let best = -1;
    // Extend the group token by token while it can still be a phone number.
    while (j < parts.length) {
      const d = digitCount(parts[j]!);
      if (digits + d > 15) break;
      digits += d;
      if (digits >= 10 && d > 0) best = j;
      j += 1;
    }
    if (best >= 0) {
      counts.phones += 1;
      out.push('[phone removed]');
      i = best + 1;
    } else {
      out.push(parts[i]!);
      i += 1;
    }
  }
  return out.join('');
}

/**
 * Data minimisation for AI inputs (Section 23): remove email addresses, phone numbers and links
 * from resume text. Names cannot be removed reliably by pattern and are not attempted; callers
 * must not send identity fields alongside the text. Deterministic, no network access.
 */
export function redactContactDetails(text: string): {
  text: string;
  redactions: ContactRedactionCounts;
} {
  const counts: ContactRedactionCounts = { emails: 0, phones: 0, urls: 0 };
  const link = (match: string) => {
    counts.urls += 1;
    // Sentence punctuation after a link is not part of it.
    return `[link removed]${/[.,;:!?]+$/.exec(match)?.[0] ?? ''}`;
  };
  let out = text.replace(EMAIL, () => {
    counts.emails += 1;
    return '[email removed]';
  });
  out = out.replace(URL_LIKE, link).replace(BARE_LINK, link).replace(PROFILE_HOSTS, link);
  out = out.replace(PHONE_RUN, (run) => redactPhoneRun(run, counts));
  return { text: out, redactions: counts };
}

/**
 * Safe display filename: last path segment only, control and reserved characters replaced,
 * whitespace collapsed, ".pdf" enforced, bounded length. Never used to build a storage path.
 */
export function sanitizeResumeFilename(raw: string | null | undefined): string {
  let name = (raw ?? '').normalize('NFKC');
  name = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_');
  name = name.replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, '');
  let base = name.replace(/\.pdf$/i, '');
  if (base === '') base = 'resume';
  // Bound by UTF-16 length (what databases and String.length count), never splitting a code point.
  const max = RESUME_LIMITS.filenameMax - 4;
  let bounded = '';
  for (const ch of base) {
    if (bounded.length + ch.length > max) break;
    bounded += ch;
  }
  return `${bounded}.pdf`;
}

/** Why a resume-based interview can or cannot start (checked before any question generation). */
export type ResumeInterviewReadiness =
  | { ready: true; version: number; textSha256: string }
  | { ready: false; reason: 'no_resume' | 'no_text' | 'consent_missing' };

export function resumeInterviewReadiness(state: CandidateResumeData): ResumeInterviewReadiness {
  if (!state.resume) return { ready: false, reason: 'no_resume' };
  if (!state.consent) return { ready: false, reason: 'consent_missing' };
  if (state.resume.extraction.status !== 'succeeded') return { ready: false, reason: 'no_text' };
  return {
    ready: true,
    version: state.resume.version,
    textSha256: state.resume.extraction.textSha256,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
