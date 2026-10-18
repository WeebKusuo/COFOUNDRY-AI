import type { CodeLanguage, CodingTaskKind, SkillId } from '@cofoundry/shared';

/**
 * Versioned coding task bank `coding-tasks-v1` (Phase 9). The interviewer model SELECTS one task
 * from this bank (it does not invent tests): hidden tests must be trustworthy, so every expected
 * value here is fixed and checked against a reference implementation in
 * test/coding.tasks.test.ts. Hidden tests and reference solutions never leave the server.
 */

export const TASK_BANK_VERSION = 'coding-tasks-v1';

export interface TestCase {
  name: string;
  /** Positional arguments, JSON-serialisable. */
  args: unknown[];
  expected: unknown;
}

export interface PerformanceCheck {
  name: string;
  /** Trusted harness code that defines `__cf_args` (an argument array) for a large input. */
  setup: Record<CodeLanguage, string>;
  /** Trusted harness code: an expression over `__cf_r` producing a small JSON summary. */
  summarize: Record<CodeLanguage, string>;
  expected: unknown;
  /** CPU seconds allowed for the performance run (functional runs get more). */
  cpuSeconds: number;
}

export interface CodingTask {
  id: string;
  version: string;
  title: string;
  kind: CodingTaskKind;
  skills: SkillId[];
  difficulty: number;
  prompt: string;
  functionName: Record<CodeLanguage, string>;
  starterCode: Record<CodeLanguage, string>;
  visibleTests: TestCase[];
  hiddenTests: TestCase[];
  performance: PerformanceCheck | null;
  /**
   * Trusted TypeScript reference solution. Used by tests to verify every expected value and by
   * the mock judge (tests/E2E only) — never sent to candidates or models.
   */
  reference: (...args: never[]) => unknown;
}

const dedupe: CodingTask = {
  id: 'dedupe-events',
  version: '1',
  title: 'Fix duplicate event removal',
  kind: 'fix_bug',
  skills: ['javascript', 'debugging', 'testing'],
  difficulty: 2,
  prompt:
    'A webhook consumer receives events that may be delivered more than once. ' +
    '`dedupeEvents(events)` must return the events with duplicates removed by `id`, keeping the ' +
    'FIRST occurrence of each id and preserving the original order. Ids may be numbers or ' +
    'strings, and the number 1 and the string "1" are different ids. The current implementation ' +
    'has bugs. Fix it so it is correct and runs in linear time.',
  functionName: { javascript: 'dedupeEvents', python: 'dedupe_events' },
  starterCode: {
    javascript: `function dedupeEvents(events) {
  const seen = {};
  for (const event of events) {
    seen[event.id] = event;
  }
  return Object.values(seen);
}
`,
    python: `def dedupe_events(events):
    seen = {}
    for event in events:
        seen[str(event["id"])] = event
    return list(seen.values())
`,
  },
  visibleTests: [
    {
      name: 'keeps the first occurrence',
      args: [
        [
          { id: 'a', v: 1 },
          { id: 'b', v: 2 },
          { id: 'a', v: 3 },
        ],
      ],
      expected: [
        { id: 'a', v: 1 },
        { id: 'b', v: 2 },
      ],
    },
    { name: 'empty input', args: [[]], expected: [] },
  ],
  hiddenTests: [
    {
      name: 'numeric ids keep arrival order',
      args: [
        [
          { id: 3, v: 'x' },
          { id: 1, v: 'y' },
          { id: 3, v: 'z' },
        ],
      ],
      expected: [
        { id: 3, v: 'x' },
        { id: 1, v: 'y' },
      ],
    },
    {
      name: 'all duplicates',
      args: [
        [
          { id: 'k', v: 1 },
          { id: 'k', v: 2 },
          { id: 'k', v: 3 },
        ],
      ],
      expected: [{ id: 'k', v: 1 }],
    },
    {
      name: 'number and string ids are distinct',
      args: [
        [
          { id: 1, v: 'num' },
          { id: '1', v: 'str' },
          { id: 1, v: 'again' },
        ],
      ],
      expected: [
        { id: 1, v: 'num' },
        { id: '1', v: 'str' },
      ],
    },
  ],
  performance: {
    name: '200,000 events with 20,000 distinct ids',
    setup: {
      javascript:
        'const __cf_args = [Array.from({ length: 200000 }, (_, i) => ({ id: i % 20000, v: i }))];',
      python: '__cf_args = [[{"id": i % 20000, "v": i} for i in range(200000)]]',
    },
    summarize: {
      javascript: '[__cf_r.length, __cf_r[0].v, __cf_r[__cf_r.length - 1].v]',
      python: '[len(__cf_r), __cf_r[0]["v"], __cf_r[-1]["v"]]',
    },
    expected: [20000, 0, 19999],
    cpuSeconds: 3,
  },
  reference: ((events: Array<{ id: unknown }>) => {
    const seen = new Set<unknown>();
    return events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  }) as never,
};

const parseQuery: CodingTask = {
  id: 'parse-query',
  version: '1',
  title: 'Parse a query string safely',
  kind: 'handle_edge_cases',
  skills: ['rest-api', 'javascript', 'testing'],
  difficulty: 2,
  prompt:
    '`parseQuery(query)` turns a URL query string into an object. Rules: a leading "?" is ' +
    'ignored; empty segments (e.g. "a=1&&b=2") are skipped; a key without "=" maps to ""; only ' +
    'the first "=" separates key and value ("a=b=c" gives "b=c"); "+" means a space; keys and ' +
    'values are percent-decoded, but a malformed escape is kept exactly as written; a key that ' +
    'appears more than once maps to an array of its values in order. The starter only handles ' +
    'the simplest case — make it handle every rule.',
  functionName: { javascript: 'parseQuery', python: 'parse_query' },
  starterCode: {
    javascript: `function parseQuery(query) {
  const result = {};
  for (const pair of query.split('&')) {
    const [key, value] = pair.split('=');
    result[key] = value;
  }
  return result;
}
`,
    python: `def parse_query(query):
    result = {}
    for pair in query.split("&"):
        key, value = pair.split("=")
        result[key] = value
    return result
`,
  },
  visibleTests: [
    { name: 'simple pairs', args: ['a=1&b=two'], expected: { a: '1', b: 'two' } },
    { name: 'empty string', args: [''], expected: {} },
  ],
  hiddenTests: [
    { name: 'leading question mark', args: ['?x=1'], expected: { x: '1' } },
    { name: 'key without value', args: ['flag'], expected: { flag: '' } },
    { name: 'repeated keys', args: ['tag=a&tag=b&tag=c'], expected: { tag: ['a', 'b', 'c'] } },
    {
      name: 'plus and percent decoding',
      args: ['q=hello+world%21'],
      expected: { q: 'hello world!' },
    },
    { name: 'empty segments', args: ['a=1&&b=2&'], expected: { a: '1', b: '2' } },
    { name: 'value containing =', args: ['eq=b=c'], expected: { eq: 'b=c' } },
    { name: 'malformed escape kept', args: ['bad=%E0%A4%A'], expected: { bad: '%E0%A4%A' } },
  ],
  performance: null,
  reference: ((query: string) => {
    const decode = (s: string) => {
      const spaced = s.replace(/\+/g, ' ');
      try {
        return decodeURIComponent(spaced);
      } catch {
        return spaced;
      }
    };
    const out: Record<string, string | string[]> = {};
    for (const part of query.replace(/^\?/, '').split('&')) {
      if (part === '') continue;
      const at = part.indexOf('=');
      const key = decode(at === -1 ? part : part.slice(0, at));
      const value = at === -1 ? '' : decode(part.slice(at + 1));
      const prev = out[key];
      out[key] =
        prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
    }
    return out;
  }) as never,
};

const rateLimit: CodingTask = {
  id: 'sliding-window-limit',
  version: '1',
  title: 'Sliding-window rate limiter',
  kind: 'complete_function',
  skills: ['rest-api', 'system-design', 'nodejs'],
  difficulty: 3,
  prompt:
    '`allowRequests(timestamps, limit, windowMs)` receives request times in milliseconds, sorted ' +
    'ascending. A request at time t is allowed when fewer than `limit` previously ALLOWED ' +
    'requests fall in the window (t - windowMs, t]. Rejected requests do not count. Return one ' +
    'boolean per request. It must handle 200,000 requests quickly.',
  functionName: { javascript: 'allowRequests', python: 'allow_requests' },
  starterCode: {
    javascript: `function allowRequests(timestamps, limit, windowMs) {
  // Return an array with one boolean per request.
  return [];
}
`,
    python: `def allow_requests(timestamps, limit, window_ms):
    # Return a list with one boolean per request.
    return []
`,
  },
  visibleTests: [
    {
      name: 'limit reached',
      args: [[0, 100, 200, 300], 3, 1000],
      expected: [true, true, true, false],
    },
    {
      name: 'window boundary is exclusive',
      args: [[0, 1000, 2000], 1, 1000],
      expected: [true, true, true],
    },
  ],
  hiddenTests: [
    { name: 'no requests', args: [[], 5, 1000], expected: [] },
    { name: 'simultaneous requests', args: [[5, 5, 5], 2, 10], expected: [true, true, false] },
    {
      name: 'rejected requests do not count',
      args: [[0, 500, 999, 1000, 1001], 2, 1000],
      expected: [true, true, false, true, false],
    },
    { name: 'zero limit', args: [[0, 10, 20], 0, 100], expected: [false, false, false] },
  ],
  performance: {
    name: '200,000 requests',
    setup: {
      javascript: 'const __cf_args = [Array.from({ length: 200000 }, (_, i) => i * 3), 50, 1000];',
      python: '__cf_args = [[i * 3 for i in range(200000)], 50, 1000]',
    },
    summarize: {
      javascript: '__cf_r.filter(Boolean).length',
      python: 'sum(1 for x in __cf_r if x)',
    },
    // Verified against the reference implementation in test/coding.tasks.test.ts.
    expected: 29950,
    cpuSeconds: 3,
  },
  reference: ((timestamps: number[], limit: number, windowMs: number) => {
    const allowed: number[] = [];
    let head = 0;
    return timestamps.map((t) => {
      while (head < allowed.length && allowed[head]! <= t - windowMs) head += 1;
      if (allowed.length - head < limit) {
        allowed.push(t);
        return true;
      }
      return false;
    });
  }) as never,
};

const mergeBookings: CodingTask = {
  id: 'merge-bookings',
  version: '1',
  title: 'Speed up booking merges',
  kind: 'improve_efficiency',
  skills: ['debugging', 'system-design', 'javascript'],
  difficulty: 3,
  prompt:
    '`mergeBookings(intervals)` merges half-open booking intervals [start, end) that overlap or ' +
    'touch (end equals the next start) and returns the merged intervals sorted by start. The ' +
    'input is unsorted and must not be modified. The current implementation is correct but far ' +
    'too slow for 100,000 bookings. Make it efficient without changing its results.',
  functionName: { javascript: 'mergeBookings', python: 'merge_bookings' },
  starterCode: {
    javascript: `function mergeBookings(intervals) {
  let result = intervals.map(([s, e]) => [s, e]);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const a = result[i];
        const b = result[j];
        if (a[0] <= b[1] && b[0] <= a[1]) {
          result[i] = [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
          result.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return result.sort((x, y) => x[0] - y[0]);
}
`,
    python: `def merge_bookings(intervals):
    result = [list(i) for i in intervals]
    merged = True
    while merged:
        merged = False
        for i in range(len(result)):
            for j in range(i + 1, len(result)):
                a, b = result[i], result[j]
                if a[0] <= b[1] and b[0] <= a[1]:
                    result[i] = [min(a[0], b[0]), max(a[1], b[1])]
                    del result[j]
                    merged = True
                    break
            if merged:
                break
    return sorted(result, key=lambda x: x[0])
`,
  },
  visibleTests: [
    {
      name: 'overlapping pair',
      args: [
        [
          [1, 3],
          [2, 6],
          [8, 10],
        ],
      ],
      expected: [
        [1, 6],
        [8, 10],
      ],
    },
    {
      name: 'unsorted input',
      args: [
        [
          [5, 7],
          [1, 2],
        ],
      ],
      expected: [
        [1, 2],
        [5, 7],
      ],
    },
  ],
  hiddenTests: [
    { name: 'empty input', args: [[]], expected: [] },
    {
      name: 'touching intervals merge',
      args: [
        [
          [1, 4],
          [4, 5],
        ],
      ],
      expected: [[1, 5]],
    },
    {
      name: 'contained intervals',
      args: [
        [
          [1, 10],
          [2, 3],
          [4, 5],
        ],
      ],
      expected: [[1, 10]],
    },
    { name: 'zero-length interval', args: [[[3, 3]]], expected: [[3, 3]] },
    {
      name: 'chain of overlaps',
      args: [
        [
          [6, 8],
          [1, 9],
          [2, 4],
          [4, 7],
        ],
      ],
      expected: [[1, 9]],
    },
  ],
  performance: {
    name: '100,000 bookings',
    setup: {
      javascript:
        'const __cf_args = [Array.from({ length: 100000 }, (_, i) => { const s = (i * 7919) % 1000003; return [s, s + 3]; })];',
      python:
        '__cf_args = [[[(i * 7919) % 1000003, (i * 7919) % 1000003 + 3] for i in range(100000)]]',
    },
    summarize: {
      javascript: '[__cf_r.length, __cf_r[0][0], __cf_r[__cf_r.length - 1][1]]',
      python: '[len(__cf_r), __cf_r[0][0], __cf_r[-1][1]]',
    },
    // Verified against the reference implementation in test/coding.tasks.test.ts.
    expected: [23994, 0, 1000003],
    cpuSeconds: 3,
  },
  reference: ((intervals: Array<[number, number]>) => {
    const sorted = intervals
      .map(([a, b]) => [a, b] as [number, number])
      .sort((x, y) => x[0] - y[0]);
    const out: Array<[number, number]> = [];
    for (const [a, b] of sorted) {
      const last = out[out.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  }) as never,
};

export const CODING_TASKS: readonly CodingTask[] = [dedupe, parseQuery, rateLimit, mergeBookings];

export function findTask(id: string): CodingTask | undefined {
  return CODING_TASKS.find((t) => t.id === id);
}

/**
 * Deterministic fallback when the selection model is unavailable: the task sharing the most
 * skills with the role (ties by id). Recorded as "rule-based selection" in the report.
 */
export function ruleBasedTask(roleSkills: readonly SkillId[]): CodingTask {
  const role = new Set(roleSkills);
  return [...CODING_TASKS].sort(
    (a, b) =>
      b.skills.filter((s) => role.has(s)).length - a.skills.filter((s) => role.has(s)).length ||
      a.id.localeCompare(b.id),
  )[0]!;
}
