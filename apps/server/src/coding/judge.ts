import { readCapped } from '../ai/transport/http-json.js';
import type { CodeLanguage } from '@cofoundry/shared';

/**
 * Code execution port (Phase 9). Candidate code is NEVER executed inside the Express process or
 * on the API host: the only real implementation sends it to a self-hosted Judge0 CE instance,
 * which runs each submission in an isolate sandbox (namespaces + cgroups) with CPU, wall-time,
 * memory, process and file-size limits and networking disabled per submission. The instance
 * must run on a dedicated, isolated host (see docs/architecture/CODE_EXECUTION.md).
 *
 * When no sandbox is configured, execution is DISABLED: runs and hidden tests are reported as
 * unavailable and no coding score is produced. There is no local fallback.
 */

export type JudgeStatus =
  'accepted' | 'compile_error' | 'runtime_error' | 'timeout' | 'memory_limit' | 'internal_error';

export interface ExecutionRequest {
  language: CodeLanguage;
  source: string;
  stdin: string;
  cpuSeconds: number;
  wallSeconds: number;
  memoryKb: number;
}

export interface ExecutionResult {
  status: JudgeStatus;
  stdout: string;
  stderr: string;
  timeSec: number | null;
  memoryKb: number | null;
}

export class JudgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeUnavailableError';
  }
}

export interface CodeJudge {
  readonly providerId: string;
  readonly available: boolean;
  /** Shown to candidates and in reports when execution is unavailable. */
  readonly unavailableReason: string | null;
  execute(req: ExecutionRequest, signal: AbortSignal): Promise<ExecutionResult>;
}

export const EXECUTION_DISABLED_MESSAGE =
  'Code execution is not available: no secure sandbox (Judge0) is configured on this server. ' +
  'Your code is still saved and reviewed, but tests cannot run and no coding score is produced.';

export const OUTPUT_LIMIT_BYTES = 64 * 1024;

export function createDisabledJudge(): CodeJudge {
  return {
    providerId: 'disabled',
    available: false,
    unavailableReason: EXECUTION_DISABLED_MESSAGE,
    async execute() {
      throw new JudgeUnavailableError(EXECUTION_DISABLED_MESSAGE);
    },
  };
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: unknown) =>
  typeof s === 'string' ? Buffer.from(s, 'base64').toString('utf8') : '';

/** Bounded text (code points), so stored diagnostics stay small. */
export function bound(text: string, max = 2_000): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}\n… (output truncated)`;
}

const SYNTAX_ERROR = /\b(SyntaxError|IndentationError|TabError)\b/;

/**
 * Judge0 CE adapter: POST /submissions?base64_encoded=true&wait=true. Requires Judge0 >= 1.13.1
 * (fixes for CVE-2024-28185/28189) configured with ALLOW_ENABLE_NETWORK=false, an AUTHN_TOKEN
 * and ENABLE_WAIT_RESULT=true.
 */
export function createJudge0(
  config: {
    url: string;
    authToken: string | null;
    languageIds: Record<CodeLanguage, number>;
    timeoutMs: number;
  },
  fetchImpl: typeof fetch = fetch,
): CodeJudge {
  const base = new URL(config.url);
  const endpoint = new URL(
    `${base.pathname.replace(/\/$/, '')}/submissions?base64_encoded=true&wait=true`,
    base.origin,
  );
  return {
    providerId: 'judge0',
    available: true,
    unavailableReason: null,
    async execute(req, signal) {
      const timeout = AbortSignal.timeout(config.timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.any([signal, timeout]),
          headers: {
            'content-type': 'application/json',
            ...(config.authToken ? { 'x-auth-token': config.authToken } : {}),
          },
          body: JSON.stringify({
            source_code: b64(req.source),
            language_id: config.languageIds[req.language],
            stdin: b64(req.stdin),
            cpu_time_limit: req.cpuSeconds,
            cpu_extra_time: 0.5,
            wall_time_limit: req.wallSeconds,
            memory_limit: req.memoryKb,
            stack_limit: 64_000,
            max_processes_and_or_threads: 60,
            max_file_size: 1_024,
            enable_network: false,
            number_of_runs: 1,
            redirect_stderr_to_stdout: false,
          }),
        });
      } catch {
        throw new JudgeUnavailableError(
          'The code execution sandbox is unreachable. Try again shortly.',
        );
      }
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel().catch(() => undefined);
        throw new JudgeUnavailableError('The code execution sandbox is busy. Try again shortly.');
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new JudgeUnavailableError(
          `The code execution sandbox refused the run (${res.status}).`,
        );
      }
      let body: {
        stdout?: unknown;
        stderr?: unknown;
        compile_output?: unknown;
        message?: unknown;
        status?: { id?: unknown };
        time?: unknown;
        memory?: unknown;
      };
      try {
        body = JSON.parse(await readCapped(res, 4 * OUTPUT_LIMIT_BYTES)) as typeof body;
      } catch {
        throw new JudgeUnavailableError('The code execution sandbox returned an invalid response.');
      }
      const id = typeof body.status?.id === 'number' ? body.status.id : 13;
      const stdout = unb64(body.stdout);
      const stderr = unb64(body.stderr) + unb64(body.compile_output);
      let status: JudgeStatus;
      if (id === 3) status = 'accepted';
      else if (id === 5) status = 'timeout';
      else if (id === 6) status = 'compile_error';
      else if (id >= 7 && id <= 12) {
        status = SYNTAX_ERROR.test(stderr)
          ? 'compile_error'
          : /MemoryError|heap out of memory|Cannot allocate memory/i.test(stderr)
            ? 'memory_limit'
            : 'runtime_error';
      } else status = 'internal_error';
      const num = (v: unknown) => {
        const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
        return Number.isFinite(n) ? n : null;
      };
      return {
        status,
        stdout: stdout.slice(0, OUTPUT_LIMIT_BYTES),
        stderr: stderr.slice(0, OUTPUT_LIMIT_BYTES),
        timeSec: num(body.time),
        memoryKb: num(body.memory),
      };
    },
  };
}

/**
 * Deterministic test double — FOR AUTOMATED TESTS AND LOCAL E2E ONLY (refused in production).
 * It NEVER executes code. It answers from markers: source containing "MOCK_COMPILE_ERROR" fails
 * to compile, "MOCK_TIMEOUT" times out; otherwise it echoes the expected outputs it is given via
 * `answer` (tests supply them) or reports every test as failed.
 */
export function createMockJudge(
  answer: (req: ExecutionRequest) => ExecutionResult | null = () => null,
): CodeJudge & { requests: ExecutionRequest[] } {
  const requests: ExecutionRequest[] = [];
  return {
    providerId: 'mock',
    available: true,
    unavailableReason: null,
    requests,
    async execute(req) {
      requests.push(req);
      if (req.source.includes('MOCK_COMPILE_ERROR')) {
        return {
          status: 'compile_error',
          stdout: '',
          stderr: 'SyntaxError: Unexpected token (mock)',
          timeSec: 0,
          memoryKb: 0,
        };
      }
      if (req.source.includes('MOCK_TIMEOUT')) {
        return { status: 'timeout', stdout: '', stderr: '', timeSec: req.cpuSeconds, memoryKb: 0 };
      }
      return (
        answer(req) ?? { status: 'accepted', stdout: '', stderr: '', timeSec: 0.01, memoryKb: 1000 }
      );
    },
  };
}
