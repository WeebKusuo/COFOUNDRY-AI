import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { RESUME_LIMITS } from '@cofoundry/shared';

/**
 * Bounded PDF text extraction (Phase 4 resume support).
 *
 * The parser (pdf.js, Apache-2.0) runs in a separate worker thread with its own heap limit and a
 * wall-clock timeout; the worker is terminated on timeout, so a hostile or pathological file
 * cannot exhaust the API process. pdf.js runs with eval disabled (no font-program compilation),
 * no font loading and no network/worker fetches. Only plain text strings leave the worker.
 */

export const PDFJS_VERSION = '6.3.289';
export const EXTRACTOR_VERSION = `pdfjs-${PDFJS_VERSION}/text-v1`;

export interface ExtractionLimits {
  maxPages: number;
  maxTextChars: number;
  timeoutMs: number;
  /** Worker heap limit. */
  maxHeapMb: number;
  /** Extractions running at once; further uploads wait their turn (bounds total memory). */
  maxConcurrent?: number;
}

export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = {
  maxPages: RESUME_LIMITS.maxPages,
  maxTextChars: RESUME_LIMITS.maxTextChars,
  timeoutMs: RESUME_LIMITS.extractionTimeoutMs,
  maxHeapMb: 256,
  maxConcurrent: 2,
};

export type ExtractionFailure = 'encrypted' | 'malformed' | 'timeout' | 'resource_limit';

export type ExtractionResult =
  | {
      ok: true;
      text: string;
      pageCount: number;
      pagesProcessed: number;
      truncated: boolean;
    }
  | { ok: false; reason: ExtractionFailure };

export type PdfTextExtractor = (bytes: Uint8Array) => Promise<ExtractionResult>;

// Plain JavaScript evaluated inside the worker. It receives the pdf.js module URL so module
// resolution does not depend on where the server bundle lives.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { moduleUrl, bytes, maxPages, maxTextChars } = workerData;
  let task;
  try {
    const pdfjs = await import(moduleUrl);
    task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      disableAutoFetch: true,
      disableStream: true,
      stopAtErrors: true,
      verbosity: 0,
    });
    const doc = await task.promise;
    const pageCount = doc.numPages;
    const pagesProcessed = Math.min(pageCount, maxPages);
    let text = '';
    let truncated = pageCount > maxPages;
    for (let n = 1; n <= pagesProcessed; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let line = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        line += item.str;
        line += item.hasEOL ? '\\n' : ' ';
      }
      page.cleanup();
      text += line.trim() + '\\n\\n';
      if (text.length > maxTextChars) {
        text = text.slice(0, maxTextChars);
        truncated = true;
        break;
      }
    }
    parentPort.postMessage({ ok: true, text, pageCount, pagesProcessed, truncated });
  } catch (err) {
    const name = err && err.name;
    parentPort.postMessage({ ok: false, reason: name === 'PasswordException' ? 'encrypted' : 'malformed' });
  } finally {
    if (task) await task.destroy().catch(() => {});
  }
})();
`;

let moduleUrlCache: string | null = null;
function pdfjsModuleUrl(): string {
  if (!moduleUrlCache) {
    const require = createRequire(import.meta.url);
    moduleUrlCache = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href;
  }
  return moduleUrlCache;
}

/** Collapses whitespace runs and strips control characters from extracted text. */
export function normalizeExtractedText(raw: string): string {
  return (
    raw
      .normalize('NFKC')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** Minimal FIFO semaphore: at most `size` tasks run at once. */
function createLimiter(size: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= size) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

export function createPdfTextExtractor(
  limits: ExtractionLimits = DEFAULT_EXTRACTION_LIMITS,
): PdfTextExtractor {
  const limit = createLimiter(Math.max(1, limits.maxConcurrent ?? 2));
  return (bytes) => limit(() => runExtraction(bytes, limits));
}

function runExtraction(bytes: Uint8Array, limits: ExtractionLimits): Promise<ExtractionResult> {
  return new Promise<ExtractionResult>((resolve) => {
    let settled = false;
    const finish = (result: ExtractionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        moduleUrl: pdfjsModuleUrl(),
        bytes,
        maxPages: limits.maxPages,
        maxTextChars: limits.maxTextChars * 2,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: limits.maxHeapMb,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
      stdout: true,
      stderr: true,
    });
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), limits.timeoutMs);
    worker.once('message', (msg: ExtractionResult) => {
      if (!msg.ok) return finish(msg);
      const text = normalizeExtractedText(msg.text);
      const truncated = msg.truncated || text.length > limits.maxTextChars;
      finish({
        ok: true,
        text: Array.from(text).slice(0, limits.maxTextChars).join(''),
        pageCount: msg.pageCount,
        pagesProcessed: msg.pagesProcessed,
        truncated,
      });
    });
    worker.once('error', (err: Error & { code?: string }) =>
      finish({
        ok: false,
        reason: err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'resource_limit' : 'malformed',
      }),
    );
    worker.once('exit', () => finish({ ok: false, reason: 'malformed' }));
  });
}
