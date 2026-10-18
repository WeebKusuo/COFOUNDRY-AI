import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { SESSION } from '@cofoundry/shared';

/**
 * Environment configuration (Contract Section 22). Startup MUST fail when required values are
 * missing or unsafe; `loadConfig` throws ConfigError listing every problem without echoing secrets.
 */

export type NodeEnv = 'development' | 'test' | 'production';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface LlmConfig {
  /** Provider label: disabled | groq | openai-compatible | mock (tests only). */
  provider: string;
  /** Model for questions, follow-ups, resume context and task selection; null when disabled. */
  interviewerModel: string | null;
  /** Separately configured evaluation model; null when disabled. */
  evaluatorModel: string | null;
  /** Backend-only secret; never sent to the browser or logged. */
  apiKey: string | null;
  /** OpenAI-compatible base URL override (Groq has a built-in default). */
  baseUrl: string | null;
  /** Per-attempt timeout. */
  timeoutMs: number;
  /** Attempts per call including the first (retry with backoff on 429/5xx/timeouts). */
  maxAttempts: number;
}

export interface SpeechConfig {
  /** disabled | http (the Python speech service) | mock (tests only). */
  provider: 'disabled' | 'http' | 'mock';
  url: string | null;
  /** Shared secret for the internal speech service (bearer token). */
  token: string | null;
  timeoutMs: number;
}

export interface CodeExecutionConfig {
  /** disabled | judge0 (self-hosted Judge0 CE) | mock (tests only; never executes code). */
  provider: 'disabled' | 'judge0' | 'mock';
  judge0Url: string | null;
  judge0AuthToken: string | null;
  /** Judge0 language ids for the supported languages (instance-specific). */
  languageIds: { javascript: number; python: number };
  timeoutMs: number;
}

export interface AppConfig {
  env: NodeEnv;
  isProduction: boolean;
  port: number;
  /** Loopback-only readiness listener; 0 disables it. */
  internalPort: number;
  /** Exact browser origin, e.g. https://cofoundry.example (no trailing slash). */
  appOrigin: string;
  mongodbUri: string;
  sessionTtlSeconds: number;
  llm: LlmConfig;
  speech: SpeechConfig;
  codeExecution: CodeExecutionConfig;
  demoMode: boolean;
  logLevel: LogLevel;
  trustProxyHops: number;
  /** Serve the built SPA from webDistDir (on by default in production). */
  serveWeb: boolean;
  webDistDir: string;
  /** Private directory for resume originals; never inside webDistDir (Phase 4). */
  resumeStorageDir: string;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const boolString = z.enum(['true', 'false']).transform((v) => v === 'true');
const optionalText = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? null : v.trim()));

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  INTERNAL_PORT: z.coerce.number().int().min(0).max(65535).default(5001),
  APP_ORIGIN: z.string({ error: 'is required' }).min(1, 'is required'),
  MONGODB_URI: z
    .string({ error: 'is required' })
    .min(1, 'is required')
    .refine((v) => /^mongodb(\+srv)?:\/\//.test(v), 'must start with mongodb:// or mongodb+srv://'),
  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(SESSION.absoluteSeconds, `SESSION_TTL_SECONDS cannot exceed ${SESSION.absoluteSeconds}`)
    .default(SESSION.absoluteSeconds),
  LLM_PROVIDER: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'LLM_PROVIDER must be a lowercase label like "disabled"')
    .default('disabled'),
  /** Phase 4 name, kept as a fallback for LLM_INTERVIEWER_MODEL. */
  LLM_MODEL: optionalText,
  LLM_INTERVIEWER_MODEL: optionalText,
  LLM_EVALUATOR_MODEL: optionalText,
  LLM_API_KEY: optionalText,
  LLM_BASE_URL: optionalText,
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  LLM_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  SPEECH_PROVIDER: z.enum(['disabled', 'http', 'mock']).default('disabled'),
  SPEECH_SERVICE_URL: optionalText,
  SPEECH_SERVICE_TOKEN: optionalText,
  SPEECH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(90_000),
  CODE_EXECUTION_PROVIDER: z.enum(['disabled', 'judge0', 'mock']).default('disabled'),
  JUDGE0_URL: optionalText,
  JUDGE0_AUTH_TOKEN: optionalText,
  JUDGE0_LANGUAGE_ID_JAVASCRIPT: z.coerce.number().int().min(1).default(63),
  JUDGE0_LANGUAGE_ID_PYTHON: z.coerce.number().int().min(1).default(71),
  JUDGE0_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  DEMO_MODE: boolString.default(true),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  SERVE_WEB: boolString.optional(),
  WEB_DIST_DIR: z.string().optional(),
  RESUME_STORAGE_DIR: z.string().optional(),
});

function serverRoot(): string {
  // Works from both src/config (tsx) and dist (bundled).
  const here = path.dirname(fileURLToPath(import.meta.url));
  return here.includes(`${path.sep}src${path.sep}`)
    ? path.resolve(here, '..', '..')
    : path.resolve(here, '..');
}

function defaultWebDistDir(): string {
  return path.resolve(serverRoot(), '..', 'web', 'dist');
}

/** Development default: apps/server/var/resumes (git-ignored, excluded from release ZIPs). */
function defaultResumeStorageDir(): string {
  return path.resolve(serverRoot(), 'var', 'resumes');
}

/** Resolves symlinks for paths that exist, so a linked directory cannot bypass the check. */
function realOrResolved(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Normalise and validate an origin string; returns null when it is not a bare origin. */
export function parseOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return url.origin;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Service endpoints: https, or http on loopback only; never embedded credentials. */
function isServiceUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopbackHost(url.hostname);
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = rawSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`),
    );
  }
  const raw = parsed.data;
  const problems: string[] = [];
  const isProduction = raw.NODE_ENV === 'production';

  const appOrigin = parseOrigin(raw.APP_ORIGIN);
  if (!appOrigin) {
    problems.push('APP_ORIGIN must be a bare origin such as https://app.example.com');
  } else {
    const { protocol, hostname } = new URL(appOrigin);
    if (isProduction && protocol !== 'https:') {
      problems.push('APP_ORIGIN must use https in production');
    }
    if (!isProduction && protocol === 'http:' && !isLoopbackHost(hostname)) {
      problems.push('APP_ORIGIN may use http only on localhost');
    }
  }

  const provider = raw.LLM_PROVIDER;
  const interviewerModel = raw.LLM_INTERVIEWER_MODEL ?? raw.LLM_MODEL;
  const evaluatorModel = raw.LLM_EVALUATOR_MODEL;
  const realLlm = provider !== 'disabled' && provider !== 'mock';
  if (realLlm) {
    if (!interviewerModel) {
      problems.push('LLM_INTERVIEWER_MODEL is required when LLM_PROVIDER is a real provider');
    }
    if (!evaluatorModel) {
      problems.push('LLM_EVALUATOR_MODEL is required when LLM_PROVIDER is a real provider');
    }
    if (!raw.LLM_API_KEY) {
      problems.push('LLM_API_KEY is required when LLM_PROVIDER is a real provider');
    }
  }
  if (isProduction && (provider === 'mock' || provider === 'fake' || provider === 'test')) {
    problems.push(`LLM_PROVIDER "${provider}" is not allowed in production`);
  }
  for (const [name, value] of [
    ['LLM_BASE_URL', raw.LLM_BASE_URL],
    ['SPEECH_SERVICE_URL', raw.SPEECH_SERVICE_URL],
    ['JUDGE0_URL', raw.JUDGE0_URL],
  ] as const) {
    if (value && !isServiceUrl(value)) {
      problems.push(`${name} must be an http(s) URL without credentials (http only on localhost)`);
    }
  }
  if (raw.SPEECH_PROVIDER === 'http') {
    if (!raw.SPEECH_SERVICE_URL)
      problems.push('SPEECH_SERVICE_URL is required when SPEECH_PROVIDER=http');
    if (!raw.SPEECH_SERVICE_TOKEN || raw.SPEECH_SERVICE_TOKEN.length < 32) {
      problems.push(
        'SPEECH_SERVICE_TOKEN (at least 32 characters) is required when SPEECH_PROVIDER=http',
      );
    }
  }
  if (raw.CODE_EXECUTION_PROVIDER === 'judge0' && !raw.JUDGE0_URL) {
    problems.push('JUDGE0_URL is required when CODE_EXECUTION_PROVIDER=judge0');
  }
  if (isProduction && raw.SPEECH_PROVIDER === 'mock') {
    problems.push('SPEECH_PROVIDER "mock" is not allowed in production');
  }
  if (isProduction && raw.CODE_EXECUTION_PROVIDER === 'mock') {
    problems.push('CODE_EXECUTION_PROVIDER "mock" is not allowed in production');
  }

  const webDistDir = raw.WEB_DIST_DIR ? path.resolve(raw.WEB_DIST_DIR) : defaultWebDistDir();
  const resumeDirRaw = raw.RESUME_STORAGE_DIR?.trim();
  if (isProduction && !resumeDirRaw) {
    problems.push('RESUME_STORAGE_DIR is required in production (a private, persistent directory)');
  }
  const resumeStorageDir = resumeDirRaw ? path.resolve(resumeDirRaw) : defaultResumeStorageDir();
  const realResume = realOrResolved(resumeStorageDir);
  const realWeb = realOrResolved(webDistDir);
  if (isInside(realResume, realWeb) || isInside(realWeb, realResume)) {
    problems.push('RESUME_STORAGE_DIR must be outside the served web directory');
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    env: raw.NODE_ENV,
    isProduction,
    port: raw.PORT,
    internalPort: raw.INTERNAL_PORT,
    appOrigin: appOrigin as string,
    mongodbUri: raw.MONGODB_URI,
    sessionTtlSeconds: raw.SESSION_TTL_SECONDS,
    llm: {
      provider,
      interviewerModel: realLlm ? interviewerModel : null,
      evaluatorModel: realLlm ? evaluatorModel : null,
      apiKey: realLlm ? raw.LLM_API_KEY : null,
      baseUrl: realLlm ? raw.LLM_BASE_URL : null,
      timeoutMs: raw.LLM_TIMEOUT_MS,
      maxAttempts: raw.LLM_MAX_ATTEMPTS,
    },
    speech: {
      provider: raw.SPEECH_PROVIDER,
      url: raw.SPEECH_PROVIDER === 'http' ? raw.SPEECH_SERVICE_URL : null,
      token: raw.SPEECH_PROVIDER === 'http' ? raw.SPEECH_SERVICE_TOKEN : null,
      timeoutMs: raw.SPEECH_TIMEOUT_MS,
    },
    codeExecution: {
      provider: raw.CODE_EXECUTION_PROVIDER,
      judge0Url: raw.CODE_EXECUTION_PROVIDER === 'judge0' ? raw.JUDGE0_URL : null,
      judge0AuthToken: raw.CODE_EXECUTION_PROVIDER === 'judge0' ? raw.JUDGE0_AUTH_TOKEN : null,
      languageIds: {
        javascript: raw.JUDGE0_LANGUAGE_ID_JAVASCRIPT,
        python: raw.JUDGE0_LANGUAGE_ID_PYTHON,
      },
      timeoutMs: raw.JUDGE0_TIMEOUT_MS,
    },
    demoMode: raw.DEMO_MODE,
    logLevel: raw.LOG_LEVEL ?? (raw.NODE_ENV === 'test' ? 'silent' : 'info'),
    trustProxyHops: raw.TRUST_PROXY_HOPS,
    serveWeb: raw.SERVE_WEB ?? isProduction,
    webDistDir,
    resumeStorageDir,
  };
}

/** A safe summary for startup logs — never includes the URI, API key or other secrets. */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    env: config.env,
    port: config.port,
    internalPort: config.internalPort,
    appOrigin: config.appOrigin,
    demoMode: config.demoMode,
    llmProvider: config.llm.provider,
    llmInterviewerModel: config.llm.interviewerModel,
    llmEvaluatorModel: config.llm.evaluatorModel,
    speechProvider: config.speech.provider,
    codeExecutionProvider: config.codeExecution.provider,
    serveWeb: config.serveWeb,
    trustProxyHops: config.trustProxyHops,
  };
}
