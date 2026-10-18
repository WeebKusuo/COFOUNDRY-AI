import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { RESUME_LIMITS, RESUME_POLICY_VERSION, redactContactDetails } from '@cofoundry/shared';
import { MemoryIdentityStore } from './support/memory-store.js';
import { MemoryProfileStore } from './support/memory-profile-store.js';
import { MemoryResumeStore } from './support/memory-resume-store.js';
import { TestClient, addTestUser, buildHarness, type Harness } from './support/harness.js';
import { createMemoryFileStorage } from '../src/resumes/storage.js';
import { createRateLimiter } from '../src/http/middleware/rate-limit.js';
import { looksLikePdf } from '../src/resumes/service.js';
import { createPdfTextExtractor, type PdfTextExtractor } from '../src/resumes/extract.js';
import { prepareResumeForInterview, readinessOf } from '../src/interviews/resume.js';
import type { UserRecord } from '../src/auth/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  fs.readFileSync(path.join(here, 'fixtures', 'resumes', `${name}.pdf`));

let ids: MemoryIdentityStore;
let pstore: MemoryProfileStore;
let rstore: MemoryResumeStore;
let files: ReturnType<typeof createMemoryFileStorage>;
let h: Harness;
let candidate: UserRecord;

const extractor = createPdfTextExtractor();

function build(options: { extractor?: PdfTextExtractor; limit?: number } = {}) {
  h = buildHarness({
    store: ids,
    profileStore: pstore,
    resumeStore: rstore,
    resumeFiles: files,
    extractor: options.extractor ?? extractor,
    ...(options.limit
      ? {
          resumeUploadLimiter: createRateLimiter({
            windowMs: 60_000,
            limit: options.limit,
            keyGenerator: (req) => `resume:${req.auth?.user?.id ?? '-'}`,
          }),
        }
      : {}),
  });
}

beforeEach(async () => {
  ids = new MemoryIdentityStore();
  pstore = new MemoryProfileStore();
  rstore = new MemoryResumeStore();
  files = createMemoryFileStorage();
  candidate = await addTestUser(ids, 'cand@test.example', ['candidate']);
  await addTestUser(ids, 'other@test.example', ['candidate']);
  await addTestUser(ids, 'founder@test.example', ['founder']);
  build();
});

async function as(email: string) {
  const client = new TestClient(h.app);
  expect((await client.login(email)).status).toBe(200);
  return client;
}

function headers(
  expectedVersion: number,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    'Content-Type': 'application/pdf',
    'X-Resume-Consent': RESUME_POLICY_VERSION,
    'X-Expected-Version': String(expectedVersion),
    'X-Filename': encodeURIComponent('Riya résumé.pdf'),
    ...overrides,
  };
}

async function upload(
  c: TestClient,
  bytes: Buffer,
  expectedVersion = 0,
  extra: Record<string, string> = {},
) {
  return c.upload('/candidate/resume', bytes, headers(expectedVersion, extra));
}

describe('resume upload validation', () => {
  it('stores a text PDF with versioned metadata, consent and no storage internals', async () => {
    const c = await as('cand@test.example');
    const res = await upload(c, fixture('resume-text'));
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).toMatchObject({
      currentVersion: 1,
      consent: true,
      policyVersion: RESUME_POLICY_VERSION,
      resume: {
        version: 1,
        filename: 'Riya résumé.pdf',
        sizeBytes: fixture('resume-text').length,
        extraction: {
          status: 'succeeded',
          pageCount: 1,
          pagesProcessed: 1,
          truncated: false,
          extractorVersion: expect.stringMatching(/^pdfjs-6\.3\.289\//),
        },
      },
    });
    expect(data.resume.fileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(data.resume.extraction.textSha256).toMatch(/^[a-f0-9]{64}$/);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('storageKey');
    expect(json).not.toMatch(/[a-f0-9]{32}\.pdf/);
    expect(json).not.toContain('riya.demo@example.com');
    expect(files.files.size).toBe(1);
    expect(
      await pstore.hasActiveConsent({
        userId: candidate.id,
        purpose: 'resume_processing',
        targetId: candidate.id,
      }),
    ).toBe(true);
  });

  it('requires consent to the current resume policy version', async () => {
    const c = await as('cand@test.example');
    for (const consent of [undefined, 'resume-processing-v0', 'yes']) {
      const h2 = headers(0);
      if (consent === undefined) delete (h2 as Record<string, string>)['X-Resume-Consent'];
      else h2['X-Resume-Consent'] = consent;
      const res = await c.upload('/candidate/resume', fixture('resume-text'), h2);
      expect(res.status).toBe(422);
      expect(res.body.error.fieldErrors).toHaveProperty('consent');
    }
    expect(files.files.size).toBe(0);
  });

  it('accepts only raw application/pdf bodies with a PDF signature', async () => {
    const c = await as('cand@test.example');
    const wrongType = await upload(c, fixture('resume-text'), 0, {
      'Content-Type': 'application/octet-stream',
    });
    expect(wrongType.status).toBe(422);
    expect(wrongType.body.error.fieldErrors.file[0]).toBe('Upload a PDF file.');
    const multipart = await c.agent
      .put('/api/v1/candidate/resume')
      .set('Origin', 'http://localhost:5173')
      .set('X-CSRF-Token', c.csrf ?? '')
      .attach('file', fixture('resume-text'), 'resume.pdf');
    expect(multipart.status).toBe(400);
    const notPdf = await upload(c, Buffer.from('<html><script>alert(1)</script></html>'.repeat(5)));
    expect(notPdf.status).toBe(422);
    expect(notPdf.body.error.fieldErrors.file[0]).toBe('This file is not a PDF.');
    const empty = await upload(c, Buffer.alloc(0));
    expect(empty.status).toBe(422);
    expect(files.files.size).toBe(0);
  });

  it('rejects files over the size limit with 413 before storing anything', async () => {
    const c = await as('cand@test.example');
    const big = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      Buffer.alloc(RESUME_LIMITS.maxBytes),
      Buffer.from('\n%%EOF\n'),
    ]);
    const res = await upload(c, big);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('BODY_TOO_LARGE');
    expect(files.files.size).toBe(0);
  });

  it('rejects malformed and password-protected PDFs and stores nothing', async () => {
    const c = await as('cand@test.example');
    const malformed = await upload(c, fixture('resume-malformed'));
    expect(malformed.status).toBe(422);
    expect(malformed.body.error.fieldErrors.file[0]).toMatch(/could not be read/);
    const encrypted = await upload(c, fixture('resume-encrypted'));
    expect(encrypted.status).toBe(422);
    expect(encrypted.body.error.fieldErrors.file[0]).toMatch(/password-protected/);
    expect(files.files.size).toBe(0);
    expect((await c.get('/candidate/resume')).body.data).toMatchObject({
      resume: null,
      currentVersion: 0,
    });
  });

  it('rejects a PDF whose extraction exceeds the time limit', async () => {
    build({
      extractor: createPdfTextExtractor({
        maxPages: 10,
        maxTextChars: 30_000,
        timeoutMs: 1,
        maxHeapMb: 64,
      }),
    });
    const c = await as('cand@test.example');
    const res = await upload(c, fixture('resume-text'));
    expect(res.status).toBe(422);
    expect(res.body.error.fieldErrors.file[0]).toMatch(/too long/);
    expect(files.files.size).toBe(0);
  });

  it('stores a PDF without text as no_text, so resume-based questions are unavailable', async () => {
    const c = await as('cand@test.example');
    const res = await upload(c, fixture('resume-no-text'));
    expect(res.status).toBe(200);
    expect(res.body.data.resume.extraction).toMatchObject({ status: 'no_text', textChars: 0 });
    expect(await prepareResumeForInterview(h.resumes, candidate.id, [])).toEqual({
      ready: false,
      reason: 'no_text',
    });
  });

  it('processes at most the page limit and marks the extraction truncated', async () => {
    const c = await as('cand@test.example');
    const res = await upload(c, fixture('resume-12-pages'));
    expect(res.status).toBe(200);
    expect(res.body.data.resume.extraction).toMatchObject({
      pageCount: 12,
      pagesProcessed: RESUME_LIMITS.maxPages,
      truncated: true,
    });
    const text = await c.get('/candidate/resume/text');
    expect(text.body.data.redactedText).toContain('Page 10 of');
    expect(text.body.data.redactedText).not.toContain('Page 11 of');
  });

  it('sanitises the display filename and never uses it for storage', async () => {
    const c = await as('cand@test.example');
    const res = await upload(c, fixture('resume-text'), 0, {
      'X-Filename': encodeURIComponent('../../etc/<passwd>\u0000.PDF'),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.resume.filename).toBe('_passwd__.pdf');
    expect([...files.files.keys()][0]).toMatch(/^[a-f0-9]{32}$/);
  });

  it('limits uploads per candidate', async () => {
    build({ limit: 2 });
    const c = await as('cand@test.example');
    expect((await upload(c, fixture('resume-text'), 0)).status).toBe(200);
    expect((await upload(c, fixture('resume-text'), 1)).status).toBe(200);
    const limited = await upload(c, fixture('resume-text'), 2);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});

describe('replace, read and delete', () => {
  it('replaces with optimistic concurrency and deletes the old file', async () => {
    const c = await as('cand@test.example');
    await upload(c, fixture('resume-text'));
    const firstKey = [...files.files.keys()][0];
    const stale = await upload(c, fixture('resume-12-pages'), 0);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const missing = await c.upload('/candidate/resume', fixture('resume-text'), {
      ...headers(1),
      'X-Expected-Version': 'one',
    });
    expect(missing.status).toBe(422);
    const res = await upload(c, fixture('resume-12-pages'), 1);
    expect(res.status).toBe(200);
    expect(res.body.data.resume.version).toBe(2);
    expect(files.files.size).toBe(1);
    expect(files.files.has(firstKey!)).toBe(false);
  });

  it('lets the owner download the original as an attachment that cannot render inline', async () => {
    const c = await as('cand@test.example');
    await upload(c, fixture('resume-text'));
    const res = await c
      .get('/candidate/resume/file')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (d: Buffer) => chunks.push(d));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body as Buffer, fixture('resume-text'))).toBe(0);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="Riya r_sum_.pdf"; filename\*=UTF-8''Riya%20r%C3%A9sum%C3%A9.pdf$/,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('shows the owner the redacted text future question generation would receive', async () => {
    const c = await as('cand@test.example');
    await upload(c, fixture('resume-text'));
    const res = await c.get('/candidate/resume/text');
    expect(res.status).toBe(200);
    const t = res.body.data.redactedText as string;
    expect(t).toContain('Built a Node.js REST API');
    expect(t).not.toContain('riya.demo@example.com');
    expect(t).not.toContain('98765');
    expect(t).not.toContain('riya-demo.example.dev');
    expect(res.body.data.redactions).toEqual({ emails: 1, phones: 1, urls: 1 });
  });

  it('deletes the file, text and metadata, withdraws consent and never reuses version numbers', async () => {
    const c = await as('cand@test.example');
    await upload(c, fixture('resume-text'));
    const del = await c.delete('/candidate/resume');
    expect(del.status).toBe(204);
    expect(files.files.size).toBe(0);
    expect((await c.get('/candidate/resume/file')).status).toBe(404);
    expect((await c.get('/candidate/resume/text')).status).toBe(404);
    const state = (await c.get('/candidate/resume')).body.data;
    // Deletion issues a new version too, so numbers are never reused.
    expect(state).toMatchObject({ resume: null, currentVersion: 2, consent: false });
    expect((await c.delete('/candidate/resume')).status).toBe(204);
    expect((await upload(c, fixture('resume-text'), 0)).status).toBe(409);
    const again = await upload(c, fixture('resume-text'), 2);
    expect(again.body.data.resume.version).toBe(3);
  });

  it('an upload started before a delete (e.g. in another tab) conflicts and leaves nothing behind', async () => {
    const c = await as('cand@test.example');
    await upload(c, fixture('resume-text'));
    await c.delete('/candidate/resume');
    const stale = await upload(c, fixture('resume-text'), 1);
    expect(stale.status).toBe(409);
    expect(files.files.size).toBe(0);
    expect((await c.get('/candidate/resume')).body.data).toMatchObject({
      resume: null,
      consent: false,
    });
  });

  it('rolls back the stored file and new consent when saving the metadata fails', async () => {
    const failing = new MemoryResumeStore();
    failing.save = async () => {
      throw new Error('database unavailable');
    };
    rstore = failing;
    build();
    const c = await as('cand@test.example');
    const res = await upload(c, fixture('resume-text'));
    expect(res.status).toBe(500);
    expect(files.files.size).toBe(0);
    expect(
      await pstore.hasActiveConsent({
        userId: candidate.id,
        purpose: 'resume_processing',
        targetId: candidate.id,
      }),
    ).toBe(false);
  });

  it('stores very long non-ASCII filenames within the limit', async () => {
    const c = await as('cand@test.example');
    const res = await upload(c, fixture('resume-text'), 0, {
      'X-Filename': encodeURIComponent('😀'.repeat(100)),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.resume.filename.length).toBeLessThanOrEqual(RESUME_LIMITS.filenameMax);
    expect(res.body.data.resume.filename.endsWith('.pdf')).toBe(true);
  });
});

describe('access control', () => {
  it('denies founders and other candidates every resume route', async () => {
    const owner = await as('cand@test.example');
    await upload(owner, fixture('resume-text'));
    const f = await as('founder@test.example');
    for (const p of ['/candidate/resume', '/candidate/resume/file', '/candidate/resume/text']) {
      expect((await f.get(p)).status, p).toBe(403);
    }
    expect((await f.upload('/candidate/resume', fixture('resume-text'), headers(0))).status).toBe(
      403,
    );
    expect((await f.delete('/candidate/resume')).status).toBe(403);
    // Another candidate only ever reaches their own (empty) resume.
    const other = await as('other@test.example');
    expect((await other.get('/candidate/resume')).body.data.resume).toBeNull();
    expect((await other.get('/candidate/resume/file')).status).toBe(404);
    expect(files.files.size).toBe(1);
  });

  it('never includes resume data in the public profile', async () => {
    const owner = await as('cand@test.example');
    await upload(owner, fixture('resume-text'));
    const res = await owner.get(`/profiles/${candidate.id}`);
    expect(JSON.stringify(res.body)).not.toMatch(/resume|Riya|invoice reconciliation/i);
  });

  it('requires a session and CSRF for uploads', async () => {
    const anon = new TestClient(h.app);
    expect((await anon.get('/candidate/resume')).status).toBe(401);
    const c = await as('cand@test.example');
    const res = await c.agent
      .put('/api/v1/candidate/resume')
      .set('Origin', 'http://localhost:5173')
      .set(headers(0))
      .send(fixture('resume-text'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });
});

describe('interview-processing integration point', () => {
  it('reports readiness: no resume, consent missing and ready with an exact reference', async () => {
    const none = await prepareResumeForInterview(h.resumes, candidate.id, []);
    expect(none).toEqual({ ready: false, reason: 'no_resume' });
    expect(readinessOf(none)).toMatchObject({
      ready: false,
      message: expect.stringMatching(/Upload your English resume/),
    });
    const c = await as('cand@test.example');
    const up = await upload(c, fixture('resume-text'));
    const ready = await prepareResumeForInterview(h.resumes, candidate.id, []);
    expect(ready).toMatchObject({
      ready: true,
      ref: {
        resumeVersion: 1,
        textSha256: up.body.data.resume.extraction.textSha256,
        extractorVersion: up.body.data.resume.extraction.extractorVersion,
      },
    });
    await pstore.withdrawConsent(
      { userId: candidate.id, purpose: 'resume_processing', targetId: candidate.id },
      new Date(),
    );
    expect(await prepareResumeForInterview(h.resumes, candidate.id, [])).toEqual({
      ready: false,
      reason: 'consent_missing',
    });
  });

  it('prepares interview resume text without contact details, links or the candidate name', async () => {
    const c = await as('cand@test.example');
    await upload(c, fixture('resume-text'));
    const prepared = await prepareResumeForInterview(h.resumes, candidate.id, ['Riya Demo']);
    expect(prepared.ready).toBe(true);
    const text = prepared.ready ? prepared.text : '';
    for (const leak of [
      candidate.id,
      'cand@test.example',
      'riya.demo@example.com',
      '98765',
      'https://',
      'Riya',
    ]) {
      expect(text).not.toContain(leak);
    }
    expect(text).toMatch(/Node\.js/);
  });
});

describe('helpers', () => {
  it('recognises PDF signatures strictly', () => {
    expect(looksLikePdf(fixture('resume-text'))).toBe(true);
    expect(looksLikePdf(Buffer.from('%PDF-1.7 but no end marker at all here'))).toBe(false);
    expect(looksLikePdf(Buffer.from('xx%PDF-1.7\n%%EOF\n%%EOF%%EOF'))).toBe(false);
  });

  it('runs extractions with bounded concurrency and still completes every request', async () => {
    const serial = createPdfTextExtractor({
      maxPages: 10,
      maxTextChars: 30_000,
      timeoutMs: 15_000,
      maxHeapMb: 128,
      maxConcurrent: 1,
    });
    const results = await Promise.all([1, 2, 3].map(() => serial(fixture('resume-text'))));
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('redacts phone numbers in common formats in linear time', () => {
    const r = redactContactDetails(
      'Call +91 98765 43210, (022) 4567-8901 or 9876543210. Year 2019-2023.',
    );
    expect(r.text).not.toMatch(/98765|4567|9876543210/);
    expect(r.text).toContain('2019-2023');
    expect(r.redactions.phones).toBe(3);
    for (const [input, phones] of [
      ['Mobile 9876543210 9123456789', 2],
      ['Phone: +91 98765 43210 2019 - 2023', 1],
    ] as const) {
      const out = redactContactDetails(input);
      expect(out.redactions.phones, input).toBe(phones);
      expect(out.text).not.toMatch(/98765|9123456789/);
    }
    expect(redactContactDetails('Phone: +91 98765 43210 2019 - 2023').text).toContain(
      '2019 - 2023',
    );
    for (const hostile of [
      '1'.repeat(200_000),
      'a'.repeat(200_000),
      '1 '.repeat(100_000),
      'x.'.repeat(100_000),
      `${'a'.repeat(100_000)}@`,
      'www.'.repeat(50_000),
    ]) {
      const start = performance.now();
      redactContactDetails(hostile);
      expect(performance.now() - start).toBeLessThan(1000);
    }
  });
});
