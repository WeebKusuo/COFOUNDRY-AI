import {
  RESUME_LIMITS,
  RESUME_POLICY_VERSION,
  redactContactDetails,
  resumeInterviewReadiness,
  sanitizeResumeFilename,
  type CandidateResumeData,
  type ResumeMetadata,
  type ResumeRef,
  type ResumeTextData,
} from '@cofoundry/shared';
import type { UserRecord } from '../auth/store.js';
import { AppError } from '../http/errors.js';
import { sha256Hex } from '../lib/canonical-json.js';
import type { ConsentKey, ProfileStore } from '../profiles/store.js';
import { EXTRACTOR_VERSION, type ExtractionFailure, type PdfTextExtractor } from './extract.js';
import type { ResumeFileStorage } from './storage.js';
import type { CurrentResume, ResumeRecord, ResumeStore } from './store.js';

export interface ResumeUpload {
  bytes: Uint8Array;
  filename: string | null;
  consentVersion: string | null;
  expectedVersion: number;
}

export interface ResumeServiceLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

/** Material for an authorised interview-processing service (never exposed over HTTP). */
export interface ResumeInterviewMaterial {
  ref: ResumeRef;
  redactedText: string;
  truncated: boolean;
}

const FAILURE_MESSAGES: Record<ExtractionFailure, string> = {
  encrypted: 'This PDF is password-protected. Upload a version without a password.',
  malformed: 'This PDF could not be read. Export it again from your editor and retry.',
  timeout: 'This PDF took too long to process. Upload a simpler or smaller export.',
  resource_limit: 'This PDF is too complex to process. Upload a simpler or smaller export.',
};

const fileError = (message: string) =>
  new AppError('VALIDATION_FAILED', message, { fieldErrors: { file: [message] } });

/**
 * Section 03-style signature check: the file must start with a PDF header and carry an end-of-file
 * marker near its end. The declared Content-Type alone is never trusted.
 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const head = Buffer.from(bytes.subarray(0, 8)).toString('latin1');
  if (!/^%PDF-[12]\.\d/.test(head)) return false;
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 2048))).toString('latin1');
  return tail.includes('%%EOF');
}

function consentKey(userId: string): ConsentKey {
  return { userId, purpose: 'resume_processing', targetId: userId };
}

function toMetadata(version: number, c: CurrentResume): ResumeMetadata {
  return {
    version,
    filename: c.filename,
    sizeBytes: c.sizeBytes,
    fileSha256: c.fileSha256,
    uploadedAt: c.uploadedAt.toISOString(),
    extraction: { ...c.extraction, extractedAt: c.extraction.extractedAt.toISOString() },
  };
}

/**
 * Candidate resume handling (Phase 4 amendment).
 *
 *  - Only the candidate's own session can upload, read metadata, download, view the redacted
 *    text or delete. No founder-facing route or projection includes any resume data.
 *  - Upload requires consent to RESUME_POLICY_VERSION. Consent is recorded before the resume is
 *    saved; deleting the resume withdraws it. Writes are ordered so that a stored resume always
 *    has an active consent and a failure never exposes data: metadata first on delete (stops all
 *    processing access), then the file, then the consent record.
 *  - Files that cannot be opened (malformed, encrypted, too slow or too complex) are rejected and
 *    never stored. PDFs without extractable text are stored with status no_text.
 */
export class ResumeService {
  constructor(
    private readonly resumes: ResumeStore,
    private readonly files: ResumeFileStorage,
    private readonly profiles: ProfileStore,
    private readonly extract: PdfTextExtractor,
    private readonly logger: ResumeServiceLogger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private readonly changeListeners: Array<(userId: string) => Promise<void>> = [];

  /**
   * Called after a candidate's resume was replaced or deleted (e.g. interviews drop material
   * prepared from the previous version). Listener failures are logged, never thrown.
   */
  onChanged(listener: (userId: string) => Promise<void>): void {
    this.changeListeners.push(listener);
  }

  private async notifyChanged(userId: string): Promise<void> {
    for (const listener of this.changeListeners) {
      try {
        await listener(userId);
      } catch (err) {
        this.logger.warn(
          { err: err instanceof Error ? err.name : 'error' },
          'resume change listener failed',
        );
      }
    }
  }

  private async view(userId: string, record: ResumeRecord | null): Promise<CandidateResumeData> {
    const consent = await this.profiles.hasActiveConsent(consentKey(userId));
    return {
      resume: record?.current ? toMetadata(record.version, record.current) : null,
      currentVersion: record?.version ?? 0,
      consent,
      policyVersion: RESUME_POLICY_VERSION,
    };
  }

  async get(user: UserRecord): Promise<CandidateResumeData> {
    return this.view(user.id, await this.resumes.find(user.id));
  }

  async upload(user: UserRecord, upload: ResumeUpload): Promise<CandidateResumeData> {
    if (upload.consentVersion !== RESUME_POLICY_VERSION) {
      throw new AppError('VALIDATION_FAILED', 'Agree to the resume processing notice to upload.', {
        fieldErrors: { consent: ['Agree to the resume processing notice to upload.'] },
      });
    }
    if (upload.bytes.length === 0) throw fileError('The file is empty.');
    if (upload.bytes.length > RESUME_LIMITS.maxBytes) {
      throw new AppError('BODY_TOO_LARGE', 'Resumes can be at most 5 MB.');
    }
    if (!looksLikePdf(upload.bytes)) throw fileError('This file is not a PDF.');

    const existing = await this.resumes.find(user.id);
    if ((existing?.version ?? 0) !== upload.expectedVersion) throw this.conflict();

    const extracted = await this.extract(upload.bytes);
    if (!extracted.ok) {
      this.logger.info({ reason: extracted.reason }, 'resume rejected by extractor');
      throw fileError(FAILURE_MESSAGES[extracted.reason]);
    }

    const at = this.now();
    const text = extracted.text;
    const current: CurrentResume = {
      storageKey: '',
      filename: sanitizeResumeFilename(upload.filename),
      sizeBytes: upload.bytes.length,
      fileSha256: sha256Hex(upload.bytes),
      uploadedAt: at,
      extraction: {
        status: text.length > 0 ? 'succeeded' : 'no_text',
        extractorVersion: EXTRACTOR_VERSION,
        pageCount: extracted.pageCount,
        pagesProcessed: extracted.pagesProcessed,
        textChars: Array.from(text).length,
        truncated: extracted.truncated,
        textSha256: sha256Hex(text),
        extractedAt: at,
      },
    };

    current.storageKey = await this.files.put(upload.bytes);
    // Consent before the resume becomes visible to any processing path.
    const key = consentKey(user.id);
    const hadConsent = await this.profiles.hasActiveConsent(key);
    let saved: Awaited<ReturnType<ResumeStore['save']>>;
    try {
      if (!hadConsent) await this.profiles.grantConsent(key, RESUME_POLICY_VERSION, at);
      saved = await this.resumes.save(user.id, upload.expectedVersion, current, text);
    } catch (err) {
      await this.rollback(user.id, current.storageKey, hadConsent);
      throw err;
    }
    if (saved === 'conflict') {
      await this.rollback(user.id, current.storageKey, hadConsent);
      throw this.conflict();
    }
    if (saved.replacedStorageKey) await this.deleteFile(saved.replacedStorageKey);
    await this.notifyChanged(user.id);
    return this.view(user.id, saved.record);
  }

  async remove(user: UserRecord): Promise<void> {
    const removedKey = await this.resumes.clear(user.id);
    if (removedKey) await this.deleteFile(removedKey);
    await this.profiles.withdrawConsent(consentKey(user.id), this.now());
    await this.notifyChanged(user.id);
  }

  async file(user: UserRecord): Promise<{ bytes: Buffer; filename: string }> {
    const record = await this.resumes.find(user.id);
    if (!record?.current) throw new AppError('NOT_FOUND', 'No resume is stored.');
    const bytes = await this.files.get(record.current.storageKey);
    if (!bytes) {
      this.logger.warn({ version: record.version }, 'resume file missing from storage');
      throw new AppError('NOT_FOUND', 'No resume is stored.');
    }
    return { bytes, filename: record.current.filename };
  }

  async text(user: UserRecord): Promise<ResumeTextData> {
    const found = await this.resumes.findWithText(user.id);
    if (!found) throw new AppError('NOT_FOUND', 'No resume is stored.');
    const redacted = redactContactDetails(found.text);
    return {
      version: found.version,
      status: found.current.extraction.status,
      redactedText: redacted.text,
      redactions: redacted.redactions,
      truncated: found.current.extraction.truncated,
    };
  }

  /**
   * The only path by which resume content leaves the candidate's own routes: for an authorised
   * interview-processing service (later phases), after re-checking consent and extraction
   * status. Returns redacted text plus the exact reference to record on the interview session.
   */
  async readForInterviewProcessing(
    candidateUserId: string,
  ): Promise<
    { ready: true; material: ResumeInterviewMaterial } | { ready: false; reason: string }
  > {
    const state = await this.view(candidateUserId, await this.resumes.find(candidateUserId));
    const readiness = resumeInterviewReadiness(state);
    if (!readiness.ready) return readiness;
    const found = await this.resumes.findWithText(candidateUserId);
    if (!found || found.version !== readiness.version) return { ready: false, reason: 'no_resume' };
    const redacted = redactContactDetails(found.text);
    return {
      ready: true,
      material: {
        ref: {
          resumeVersion: found.version,
          textSha256: found.current.extraction.textSha256,
          extractorVersion: found.current.extraction.extractorVersion,
        },
        redactedText: redacted.text,
        truncated: found.current.extraction.truncated,
      },
    };
  }

  /**
   * Undo a failed upload: remove the unreferenced file and, if this attempt granted the consent
   * and no resume is stored (another tab may have saved one meanwhile), withdraw it again.
   */
  private async rollback(userId: string, storageKey: string, hadConsent: boolean): Promise<void> {
    await this.deleteFile(storageKey);
    if (hadConsent) return;
    const stored = await this.resumes.find(userId);
    if (!stored?.current) await this.profiles.withdrawConsent(consentKey(userId), this.now());
  }

  private conflict() {
    return new AppError(
      'VERSION_CONFLICT',
      'Your resume changed since you opened this page. Reload to see the latest version.',
    );
  }

  private async deleteFile(key: string): Promise<void> {
    try {
      await this.files.delete(key);
    } catch (err) {
      // The metadata no longer references the file, so it is unreachable; log for cleanup.
      this.logger.warn({ err }, 'failed to delete replaced resume file');
    }
  }
}
