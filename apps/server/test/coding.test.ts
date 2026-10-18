import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodeLanguage } from '@cofoundry/shared';
import {
  buildHarness,
  gradeSubmission,
  parseHarnessOutput,
  runVisibleTests,
} from '../src/coding/grading.js';
import {
  createDisabledJudge,
  createJudge0,
  createMockJudge,
  type CodeJudge,
  type ExecutionRequest,
} from '../src/coding/judge.js';
import { CODING_TASKS, findTask, ruleBasedTask, type CodingTask } from '../src/coding/tasks.js';

/** Trusted reference solutions written for these tests (NOT candidate code). */
const SOLUTIONS: Record<string, Record<CodeLanguage, string>> = {
  'dedupe-events': {
    javascript: `function dedupeEvents(events) {
  const seen = new Set();
  return events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}`,
    python: `def dedupe_events(events):
    seen = set()
    out = []
    for e in events:
        key = (type(e["id"]).__name__, e["id"])
        if key not in seen:
            seen.add(key)
            out.append(e)
    return out`,
  },
  'parse-query': {
    javascript: `function parseQuery(query) {
  const decode = (s) => { const v = s.replace(/\\+/g, ' '); try { return decodeURIComponent(v); } catch { return v; } };
  const out = {};
  for (const part of query.replace(/^\\?/, '').split('&')) {
    if (part === '') continue;
    const at = part.indexOf('=');
    const key = decode(at === -1 ? part : part.slice(0, at));
    const value = at === -1 ? '' : decode(part.slice(at + 1));
    if (!(key in out)) out[key] = value;
    else out[key] = Array.isArray(out[key]) ? [...out[key], value] : [out[key], value];
  }
  return out;
}`,
    python: `from urllib.parse import unquote_to_bytes


def parse_query(query):
    def decode(s):
        s = s.replace("+", " ")
        if "%" not in s:
            return s
        try:
            return unquote_to_bytes(s).decode("utf-8")
        except UnicodeDecodeError:
            return s
    out = {}
    q = query[1:] if query.startswith("?") else query
    for part in q.split("&"):
        if part == "":
            continue
        key, sep, value = part.partition("=")
        key, value = decode(key), decode(value) if sep else ""
        if key not in out:
            out[key] = value
        elif isinstance(out[key], list):
            out[key].append(value)
        else:
            out[key] = [out[key], value]
    return out`,
  },
  'sliding-window-limit': {
    javascript: `function allowRequests(timestamps, limit, windowMs) {
  const allowed = []; let head = 0;
  return timestamps.map((t) => {
    while (head < allowed.length && allowed[head] <= t - windowMs) head++;
    if (allowed.length - head < limit) { allowed.push(t); return true; }
    return false;
  });
}`,
    python: `from collections import deque


def allow_requests(timestamps, limit, window_ms):
    q = deque()
    out = []
    for t in timestamps:
        while q and q[0] <= t - window_ms:
            q.popleft()
        if len(q) < limit:
            q.append(t)
            out.append(True)
        else:
            out.append(False)
    return out`,
  },
  'merge-bookings': {
    javascript: `function mergeBookings(intervals) {
  const s = intervals.map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of s) { const l = out[out.length - 1]; if (l && a <= l[1]) l[1] = Math.max(l[1], b); else out.push([a, b]); }
  return out;
}`,
    python: `def merge_bookings(intervals):
    out = []
    for a, b in sorted(([s, e] for s, e in intervals), key=lambda x: x[0]):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out`,
  },
};

describe('coding task bank', () => {
  it.each(CODING_TASKS.map((t) => [t.id, t] as const))(
    '%s: every expected value matches the trusted reference',
    (_id, task) => {
      for (const t of [...task.visibleTests, ...task.hiddenTests]) {
        expect(task.reference(...(t.args as never[])), t.name).toEqual(t.expected);
      }
    },
  );

  it('has hidden edge cases for every task and performance checks where efficiency matters', () => {
    for (const t of CODING_TASKS) {
      expect(t.hiddenTests.length).toBeGreaterThanOrEqual(3);
      expect(Object.keys(t.starterCode)).toEqual(['javascript', 'python']);
    }
    expect(findTask('merge-bookings')!.kind).toBe('improve_efficiency');
    expect(findTask('merge-bookings')!.performance).not.toBeNull();
  });

  it('falls back to a deterministic rule-based choice', () => {
    expect(ruleBasedTask(['rest-api', 'system-design', 'nodejs']).id).toBe('sliding-window-limit');
  });
});

/**
 * Harness verification. These run ONLY trusted code from this repository — the reference
 * solutions above and the task starters — through the real harness with local node/python3,
 * to prove the generated harness programs are correct. Candidate code is never executed on the
 * host: in the product, code only runs inside the configured Judge0 sandbox.
 */
function runTrusted(req: ExecutionRequest): string {
  const cmd = req.language === 'javascript' ? process.execPath : 'python3';
  const args = req.language === 'javascript' ? ['-e', req.source] : ['-I', '-c', req.source];
  try {
    return execFileSync(cmd, args, {
      input: req.stdin,
      timeout: 20_000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    return String((err as { stdout?: string }).stdout ?? '');
  }
}

const hasPython = (() => {
  try {
    execFileSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
})();

function trustedJudge(): CodeJudge {
  return createMockJudge((req) => ({
    status: 'accepted',
    stdout: runTrusted(req),
    stderr: '',
    timeSec: 0.1,
    memoryKb: 1,
  }));
}

describe('harness programs (trusted code only)', () => {
  const languages: CodeLanguage[] = hasPython ? ['javascript', 'python'] : ['javascript'];
  for (const language of languages) {
    it.each(CODING_TASKS.map((t) => [t.id, t] as const))(
      `${language}: %s reference solution passes every test`,
      async (_id, task: CodingTask) => {
        const graded = await gradeSubmission(
          trustedJudge(),
          task,
          language,
          SOLUTIONS[task.id]![language],
          AbortSignal.timeout(60_000),
        );
        const failed = graded.tests.filter((t) => t.outcome !== 'passed');
        expect(failed, JSON.stringify(failed)).toEqual([]);
      },
      60_000,
    );

    it(`${language}: starter code fails the hidden cases`, async () => {
      const task = findTask('dedupe-events')!;
      const graded = await gradeSubmission(
        trustedJudge(),
        task,
        language,
        task.starterCode[language],
        AbortSignal.timeout(60_000),
      );
      expect(graded.tests.some((t) => t.category === 'hidden' && t.outcome !== 'passed')).toBe(
        true,
      );
    }, 60_000);
  }

  it('reports a missing function clearly', async () => {
    const task = findTask('parse-query')!;
    const graded = await runVisibleTests(
      trustedJudge(),
      task,
      'javascript',
      'function wrongName() {}',
      AbortSignal.timeout(10_000),
    );
    expect(graded.tests[0]!.message).toBe('Define a function named parseQuery.');
  });
});

describe('result integrity', () => {
  it('ignores forged output printed by candidate code: only the last marker counts and values are compared server-side', () => {
    const run = buildHarness(
      findTask('dedupe-events')!,
      'javascript',
      'function dedupeEvents(e){return e}',
      [{ name: 'x', args: [[]], expected: [] }],
    );
    const forged = `${run.marker}[{"ok":true,"v":"[]"}]\n`;
    const real = `${run.marker}[{"ok":true,"v":"[1]"}]\n`;
    const parsed = parseHarnessOutput(`${forged}noise\n${real}`, run.marker);
    expect(parsed).toEqual({ entries: [{ ok: true, v: '[1]' }] });
    expect(run.source).not.toContain('expected');
    expect(run.stdin).toBe('[[[]]]');
  });

  it('never sends hidden expected values into the sandbox', () => {
    const task = findTask('parse-query')!;
    const run = buildHarness(task, 'python', 'def parse_query(q): return {}', task.hiddenTests);
    for (const t of task.hiddenTests)
      expect(run.source + run.stdin).not.toContain(JSON.stringify(t.expected));
  });
});

describe('sandbox adapters', () => {
  let server: http.Server;
  let url: string;
  const seen: Array<{ url: string; token: string | undefined; body: Record<string, unknown> }> = [];
  let reply: { status: number; body: unknown } = { status: 201, body: {} };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        seen.push({
          url: req.url ?? '',
          token: req.headers['x-auth-token'] as string | undefined,
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        res.statusCode = reply.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const judge = () =>
    createJudge0({
      url,
      authToken: 'judge-token',
      languageIds: { javascript: 63, python: 71 },
      timeoutMs: 5000,
    });
  const req: ExecutionRequest = {
    language: 'python',
    source: 'print(1)',
    stdin: '[]',
    cpuSeconds: 5,
    wallSeconds: 10,
    memoryKb: 256000,
  };

  it('submits with network disabled, strict limits, base64 and the auth token', async () => {
    reply = {
      status: 201,
      body: {
        stdout: b64('1\n'),
        stderr: null,
        compile_output: null,
        status: { id: 3 },
        time: '0.02',
        memory: 3000,
      },
    };
    const r = await judge().execute(req, AbortSignal.timeout(5000));
    expect(r).toMatchObject({ status: 'accepted', stdout: '1\n', timeSec: 0.02, memoryKb: 3000 });
    const sent = seen[seen.length - 1]!;
    expect(sent.url).toBe('/submissions?base64_encoded=true&wait=true');
    expect(sent.token).toBe('judge-token');
    expect(sent.body).toMatchObject({
      language_id: 71,
      source_code: b64('print(1)'),
      enable_network: false,
      cpu_time_limit: 5,
      wall_time_limit: 10,
      memory_limit: 256000,
      max_file_size: 1024,
      max_processes_and_or_threads: 60,
    });
  });

  it.each([
    [5, '', 'timeout'],
    [6, '', 'compile_error'],
    [11, 'SyntaxError: invalid syntax', 'compile_error'],
    [11, 'MemoryError', 'memory_limit'],
    [12, 'boom', 'runtime_error'],
    [13, '', 'internal_error'],
  ])('maps Judge0 status %i (%s) to %s', async (id, stderr, status) => {
    reply = { status: 201, body: { stdout: null, stderr: b64(stderr), status: { id } } };
    expect((await judge().execute(req, AbortSignal.timeout(5000))).status).toBe(status);
  });

  it('treats sandbox outages as unavailable, never as a result', async () => {
    reply = { status: 503, body: {} };
    await expect(judge().execute(req, AbortSignal.timeout(5000))).rejects.toThrow(/busy/);
  });

  it('the disabled judge refuses to run anything', async () => {
    const d = createDisabledJudge();
    expect(d.available).toBe(false);
    await expect(d.execute(req, AbortSignal.timeout(100))).rejects.toThrow(/no secure sandbox/);
  });
});
