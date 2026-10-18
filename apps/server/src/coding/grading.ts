import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CodeLanguage, ExecutionStatus, TestOutcome } from '@cofoundry/shared';
import {
  JudgeUnavailableError,
  bound,
  createMockJudge,
  type CodeJudge,
  type ExecutionResult,
} from './judge.js';
import { CODING_TASKS, type CodingTask, type TestCase } from './tasks.js';

/**
 * Deterministic test grading (Phase 9). Candidate code is wrapped in a small trusted harness
 * that calls the task function for each test's arguments and prints the JSON-encoded results
 * after a per-run random marker. The harness NEVER receives expected values: outputs are compared
 * on the server, so printing fake results cannot pass a test without producing the right value.
 */

const MARK_PREFIX = '<<CF_RESULT:';

export interface HarnessRun {
  source: string;
  stdin: string;
  marker: string;
}

function jsHarness(task: CodingTask, code: string, marker: string, perf: boolean): string {
  const fn = task.functionName.javascript;
  const body = perf
    ? `${task.performance!.setup.javascript}
    let __cf_r;
    try { __cf_r = __cf_fn(...__cf_args); __cf_out.push({ ok: true, v: JSON.stringify(${task.performance!.summarize.javascript}) ?? null }); }
    catch (e) { __cf_out.push({ ok: false, e: String(e && e.name || 'Error') + ': ' + String(e && e.message || e).slice(0, 300) }); }`
    : `const __cf_input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    for (const __cf_args of __cf_input) {
      try { const __cf_v = __cf_fn(...__cf_args); const __cf_s = JSON.stringify(__cf_v); __cf_out.push(__cf_s === undefined ? { ok: false, e: 'TypeError: function returned undefined' } : { ok: true, v: __cf_s }); }
      catch (e) { __cf_out.push({ ok: false, e: String(e && e.name || 'Error') + ': ' + String(e && e.message || e).slice(0, 300) }); }
    }`;
  return `// cf-task: ${task.id}@${task.version}
${code}
;(() => {
  const __cf_out = [];
  let __cf_fn;
  try { __cf_fn = ${fn}; } catch (e) { __cf_fn = undefined; }
  if (typeof __cf_fn !== 'function') {
    process.stdout.write('\\n${marker}' + JSON.stringify({ missing: '${fn}' }) + '\\n');
    return;
  }
  ${body}
  process.stdout.write('\\n${marker}' + JSON.stringify(__cf_out) + '\\n');
})();
`;
}

function pyHarness(task: CodingTask, code: string, marker: string, perf: boolean): string {
  const fn = task.functionName.python;
  const body = perf
    ? `    ${task.performance!.setup.python}
    try:
        __cf_r = __cf_fn(*__cf_args)
        __cf_out.append({"ok": True, "v": __cf_json.dumps(${task.performance!.summarize.python})})
    except BaseException as __cf_e:
        __cf_out.append({"ok": False, "e": (type(__cf_e).__name__ + ": " + str(__cf_e))[:300]})`
    : `    __cf_input = __cf_json.loads(__cf_sys.stdin.read())
    for __cf_args in __cf_input:
        try:
            __cf_out.append({"ok": True, "v": __cf_json.dumps(__cf_fn(*__cf_args))})
        except BaseException as __cf_e:
            __cf_out.append({"ok": False, "e": (type(__cf_e).__name__ + ": " + str(__cf_e))[:300]})`;
  return `# cf-task: ${task.id}@${task.version}
${code}


def __cf_main():
    import json as __cf_json
    import sys as __cf_sys
    __cf_fn = globals().get("${fn}")
    if not callable(__cf_fn):
        __cf_sys.stdout.write("\\n${marker}" + __cf_json.dumps({"missing": "${fn}"}) + "\\n")
        return
    __cf_out = []
${body}
    __cf_sys.stdout.write("\\n${marker}" + __cf_json.dumps(__cf_out) + "\\n")


__cf_main()
`;
}

export function buildHarness(
  task: CodingTask,
  language: CodeLanguage,
  code: string,
  tests: readonly TestCase[] | 'performance',
): HarnessRun {
  const marker = `${MARK_PREFIX}${randomBytes(12).toString('hex')}>>`;
  const perf = tests === 'performance';
  const source =
    language === 'javascript'
      ? jsHarness(task, code, marker, perf)
      : pyHarness(task, code, marker, perf);
  return { source, stdin: perf ? '[]' : JSON.stringify(tests.map((t) => t.args)), marker };
}

type HarnessEntry = { ok: true; v: string | null } | { ok: false; e: string };

/** The LAST marker line wins; anything the candidate printed before it is ignored. */
export function parseHarnessOutput(
  stdout: string,
  marker: string,
): { entries: HarnessEntry[] } | { missing: string } | null {
  const at = stdout.lastIndexOf(marker);
  if (at === -1) return null;
  const line = stdout.slice(at + marker.length).split('\n')[0] ?? '';
  try {
    const parsed: unknown = JSON.parse(line);
    if (Array.isArray(parsed)) {
      const entries: HarnessEntry[] = [];
      for (const e of parsed) {
        if (typeof e === 'object' && e !== null && (e as { ok?: unknown }).ok === true) {
          const v = (e as { v?: unknown }).v;
          entries.push({ ok: true, v: typeof v === 'string' ? v : null });
        } else {
          const msg = (e as { e?: unknown } | null)?.e;
          entries.push({ ok: false, e: typeof msg === 'string' ? msg.slice(0, 300) : 'Error' });
        }
      }
      return { entries };
    }
    if (typeof parsed === 'object' && parsed !== null && 'missing' in parsed) {
      return { missing: String((parsed as { missing: unknown }).missing) };
    }
  } catch {
    return null;
  }
  return null;
}

function sameJson(actualJson: string | null, expected: unknown): boolean {
  if (actualJson === null) return false;
  try {
    return isDeepStrictEqual(JSON.parse(actualJson), JSON.parse(JSON.stringify(expected)));
  } catch {
    return false;
  }
}

export interface GradedTest {
  name: string;
  category: 'visible' | 'hidden' | 'performance';
  outcome: TestOutcome;
  /** Only for visible tests (never hidden expected values). */
  expected: string | null;
  actual: string | null;
  message: string | null;
}

export interface GradeResult {
  status: ExecutionStatus;
  tests: GradedTest[];
  diagnostics: string | null;
  compileError: boolean;
}

const compact = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > 500 ? `${s.slice(0, 500)}…` : s;
};

function mapStatus(r: ExecutionResult): ExecutionStatus {
  switch (r.status) {
    case 'accepted':
      return 'completed';
    case 'compile_error':
      return 'compile_error';
    case 'timeout':
      return 'timeout';
    case 'memory_limit':
      return 'memory_limit';
    case 'runtime_error':
      return 'runtime_error';
    default:
      return 'internal_error';
  }
}

async function runCases(
  judge: CodeJudge,
  task: CodingTask,
  language: CodeLanguage,
  code: string,
  cases: Array<TestCase & { category: 'visible' | 'hidden' }>,
  signal: AbortSignal,
): Promise<GradeResult> {
  const run = buildHarness(task, language, code, cases);
  const result = await judge.execute(
    {
      language,
      source: run.source,
      stdin: run.stdin,
      cpuSeconds: 5,
      wallSeconds: 10,
      memoryKb: 256_000,
    },
    signal,
  );
  const status = mapStatus(result);
  const diagnostics = result.stderr.trim() ? bound(result.stderr.trim()) : null;
  const parsed =
    result.status === 'accepted' || result.status === 'runtime_error'
      ? parseHarnessOutput(result.stdout, run.marker)
      : null;
  const failAll = (outcome: TestOutcome, message: string): GradedTest[] =>
    cases.map((c) => ({
      name: c.name,
      category: c.category,
      outcome,
      expected: c.category === 'visible' ? compact(c.expected) : null,
      actual: null,
      message,
    }));
  if (!parsed) {
    const message =
      status === 'compile_error'
        ? 'The code did not compile.'
        : status === 'timeout'
          ? 'Time limit exceeded.'
          : status === 'memory_limit'
            ? 'Memory limit exceeded.'
            : status === 'internal_error'
              ? 'The sandbox reported an internal error.'
              : 'The program stopped before reporting results.';
    return {
      status: status === 'completed' ? 'runtime_error' : status,
      tests: failAll(status === 'timeout' ? 'timeout' : 'error', message),
      diagnostics,
      compileError: status === 'compile_error',
    };
  }
  if ('missing' in parsed) {
    return {
      status: 'runtime_error',
      tests: failAll('error', `Define a function named ${parsed.missing}.`),
      diagnostics,
      compileError: false,
    };
  }
  const tests = cases.map((c, i): GradedTest => {
    const entry = parsed.entries[i];
    const visible = c.category === 'visible';
    if (!entry) {
      return {
        name: c.name,
        category: c.category,
        outcome: 'error',
        expected: visible ? compact(c.expected) : null,
        actual: null,
        message: 'No result.',
      };
    }
    if (!entry.ok) {
      return {
        name: c.name,
        category: c.category,
        outcome: 'error',
        expected: visible ? compact(c.expected) : null,
        actual: null,
        message: visible ? entry.e : 'Raised an error.',
      };
    }
    const pass = sameJson(entry.v, c.expected);
    return {
      name: c.name,
      category: c.category,
      outcome: pass ? 'passed' : 'failed',
      expected: visible ? compact(c.expected) : null,
      actual:
        visible && entry.v !== null
          ? entry.v.length > 500
            ? `${entry.v.slice(0, 500)}…`
            : entry.v
          : null,
      message: null,
    };
  });
  return { status: 'completed', tests, diagnostics, compileError: false };
}

/** Candidate "Run": visible tests only. */
export function runVisibleTests(
  judge: CodeJudge,
  task: CodingTask,
  language: CodeLanguage,
  code: string,
  signal: AbortSignal,
): Promise<GradeResult> {
  return runCases(
    judge,
    task,
    language,
    code,
    task.visibleTests.map((t) => ({ ...t, category: 'visible' as const })),
    signal,
  );
}

/** Final grading: visible + hidden functional tests, then the performance check. */
export async function gradeSubmission(
  judge: CodeJudge,
  task: CodingTask,
  language: CodeLanguage,
  code: string,
  signal: AbortSignal,
): Promise<GradeResult> {
  const functional = await runCases(
    judge,
    task,
    language,
    code,
    [
      ...task.visibleTests.map((t) => ({ ...t, category: 'visible' as const })),
      ...task.hiddenTests.map((t) => ({ ...t, category: 'hidden' as const })),
    ],
    signal,
  );
  if (!task.performance) return functional;
  const perf = task.performance;
  let outcome: TestOutcome = 'error';
  let message: string | null = null;
  if (functional.compileError) {
    message = 'Not run: the code did not compile.';
  } else {
    const run = buildHarness(task, language, code, 'performance');
    const result = await judge.execute(
      {
        language,
        source: run.source,
        stdin: run.stdin,
        cpuSeconds: perf.cpuSeconds,
        wallSeconds: perf.cpuSeconds * 2 + 2,
        memoryKb: 256_000,
      },
      signal,
    );
    // A sandbox fault on the performance run is not the candidate's failure.
    if (result.status === 'internal_error') return { ...functional, status: 'internal_error' };
    if (result.status === 'timeout') {
      outcome = 'timeout';
      message = `Did not finish within ${perf.cpuSeconds} CPU seconds.`;
    } else {
      const parsed = parseHarnessOutput(result.stdout, run.marker);
      const entry = parsed && 'entries' in parsed ? parsed.entries[0] : undefined;
      if (entry?.ok) {
        outcome = sameJson(entry.v, perf.expected) ? 'passed' : 'failed';
      } else {
        message =
          result.status === 'memory_limit'
            ? 'Memory limit exceeded.'
            : 'Raised an error on the large input.';
      }
    }
  }
  return {
    ...functional,
    tests: [
      ...functional.tests,
      { name: perf.name, category: 'performance', outcome, expected: null, actual: null, message },
    ],
  };
}

export { JudgeUnavailableError };

/**
 * Mock judge for tests and local E2E only: NEVER executes code. Source containing
 * "MOCK_REFERENCE" is answered with the outputs of the trusted TypeScript reference solution
 * (so a full pass can be demonstrated end to end); anything else gets the reference outputs of
 * an always-wrong function (every test fails), plus the compile-error/timeout markers of
 * createMockJudge.
 */
export function createReferenceMockJudge() {
  return createMockJudge((req) => {
    const header = /cf-task: ([a-z0-9-]+)@/.exec(req.source);
    const task = CODING_TASKS.find((t) => t.id === header?.[1]);
    const marker = /(<<CF_RESULT:[0-9a-f]+>>)/.exec(req.source)?.[1];
    if (!task || !marker) return null;
    const pass = req.source.includes('MOCK_REFERENCE');
    let payload: unknown;
    if (req.stdin === '[]' && task.performance) {
      payload = [{ ok: true, v: JSON.stringify(pass ? task.performance.expected : null) }];
    } else {
      const argsList = JSON.parse(req.stdin) as unknown[][];
      payload = argsList.map((args) => ({
        ok: true,
        v: JSON.stringify(pass ? task.reference(...(args as never[])) : null),
      }));
    }
    return {
      status: 'accepted',
      stdout: `mock\n${marker}${JSON.stringify(payload)}\n`,
      stderr: '',
      timeSec: 0.01,
      memoryKb: 1000,
    };
  });
}
