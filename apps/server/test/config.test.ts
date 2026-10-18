import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadConfig, parseOrigin } from '../src/config/env.js';

const base = {
  NODE_ENV: 'development',
  APP_ORIGIN: 'http://localhost:5173',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/cofoundry?replicaSet=rs0',
};

const production = {
  NODE_ENV: 'production',
  APP_ORIGIN: 'https://cofoundry.example.com',
  MONGODB_URI: 'mongodb+srv://user:secret@cluster.example.net/cofoundry',
  LLM_PROVIDER: 'disabled',
  RESUME_STORAGE_DIR: '/srv/cofoundry/resumes',
};

function problemsOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

describe('loadConfig', () => {
  it('applies contract defaults in development', () => {
    const config = loadConfig(base);
    expect(config.port).toBe(5000);
    expect(config.sessionTtlSeconds).toBe(28_800);
    expect(config.llm).toEqual({
      provider: 'disabled',
      interviewerModel: null,
      evaluatorModel: null,
      apiKey: null,
      baseUrl: null,
      timeoutMs: 20_000,
      maxAttempts: 3,
    });
    expect(config.speech.provider).toBe('disabled');
    expect(config.codeExecution).toMatchObject({ provider: 'disabled', judge0Url: null });
    expect(config.demoMode).toBe(true);
    expect(config.serveWeb).toBe(false);
  });

  it('accepts a valid production configuration and serves the SPA', () => {
    const config = loadConfig(production);
    expect(config.isProduction).toBe(true);
    expect(config.serveWeb).toBe(true);
    expect(config.appOrigin).toBe('https://cofoundry.example.com');
  });

  it('fails when required values are missing', () => {
    const problems = problemsOf({ NODE_ENV: 'production' });
    expect(problems.join('\n')).toMatch(/APP_ORIGIN/);
    expect(problems.join('\n')).toMatch(/MONGODB_URI/);
  });

  it('requires a private resume directory in production and keeps it outside the web build', () => {
    const { RESUME_STORAGE_DIR: _omit, ...withoutDir } = production;
    expect(problemsOf(withoutDir)).toContain(
      'RESUME_STORAGE_DIR is required in production (a private, persistent directory)',
    );
    expect(
      problemsOf({ ...production, WEB_DIST_DIR: '/srv/web', RESUME_STORAGE_DIR: '/srv/web/files' }),
    ).toContain('RESUME_STORAGE_DIR must be outside the served web directory');
    expect(loadConfig(production).resumeStorageDir).toBe('/srv/cofoundry/resumes');
  });

  it('defaults the resume directory to a git-ignored folder outside the web build in development', () => {
    const config = loadConfig(base);
    expect(config.resumeStorageDir).toMatch(/apps[\\/]server[\\/]var[\\/]resumes$/);
  });

  it('refuses a non-HTTPS origin in production', () => {
    expect(problemsOf({ ...production, APP_ORIGIN: 'http://cofoundry.example.com' })).toContain(
      'APP_ORIGIN must use https in production',
    );
  });

  it('allows http only on localhost outside production', () => {
    expect(problemsOf({ ...base, APP_ORIGIN: 'http://192.168.1.4:5173' })).toContain(
      'APP_ORIGIN may use http only on localhost',
    );
  });

  it('requires a bare origin', () => {
    expect(problemsOf({ ...base, APP_ORIGIN: 'http://localhost:5173/app' })[0]).toMatch(
      /bare origin/,
    );
  });

  it('requires separately configured models and a key when a real LLM provider is enabled', () => {
    const problems = problemsOf({ ...base, LLM_PROVIDER: 'groq' });
    expect(problems).toEqual([
      'LLM_INTERVIEWER_MODEL is required when LLM_PROVIDER is a real provider',
      'LLM_EVALUATOR_MODEL is required when LLM_PROVIDER is a real provider',
      'LLM_API_KEY is required when LLM_PROVIDER is a real provider',
    ]);
    const ok = loadConfig({
      ...base,
      LLM_PROVIDER: 'groq',
      LLM_INTERVIEWER_MODEL: 'llama-3.3-70b-versatile',
      LLM_EVALUATOR_MODEL: 'openai/gpt-oss-120b',
      LLM_API_KEY: 'gsk_x',
    });
    expect(ok.llm).toMatchObject({
      interviewerModel: 'llama-3.3-70b-versatile',
      evaluatorModel: 'openai/gpt-oss-120b',
    });
    // The Phase 4 LLM_MODEL name still works as the interviewer model.
    expect(
      loadConfig({
        ...base,
        LLM_PROVIDER: 'groq',
        LLM_MODEL: 'm1',
        LLM_EVALUATOR_MODEL: 'm2',
        LLM_API_KEY: 'k',
      }).llm.interviewerModel,
    ).toBe('m1');
  });

  it('validates speech and code-execution settings', () => {
    expect(problemsOf({ ...base, SPEECH_PROVIDER: 'http' })).toEqual([
      'SPEECH_SERVICE_URL is required when SPEECH_PROVIDER=http',
      'SPEECH_SERVICE_TOKEN (at least 32 characters) is required when SPEECH_PROVIDER=http',
    ]);
    expect(problemsOf({ ...base, CODE_EXECUTION_PROVIDER: 'judge0' })).toEqual([
      'JUDGE0_URL is required when CODE_EXECUTION_PROVIDER=judge0',
    ]);
    expect(problemsOf({ ...base, JUDGE0_URL: 'http://10.0.0.8:2358' })[0]).toMatch(
      /JUDGE0_URL must be an http\(s\) URL/,
    );
    expect(problemsOf({ ...base, SPEECH_SERVICE_URL: 'https://u:p@speech.example' })[0]).toMatch(
      /without credentials/,
    );
    expect(
      problemsOf({ ...production, SPEECH_PROVIDER: 'mock', CODE_EXECUTION_PROVIDER: 'mock' }),
    ).toEqual([
      'SPEECH_PROVIDER "mock" is not allowed in production',
      'CODE_EXECUTION_PROVIDER "mock" is not allowed in production',
    ]);
    const c = loadConfig({
      ...base,
      SPEECH_PROVIDER: 'http',
      SPEECH_SERVICE_URL: 'http://127.0.0.1:8765',
      SPEECH_SERVICE_TOKEN: 'x'.repeat(32),
      CODE_EXECUTION_PROVIDER: 'judge0',
      JUDGE0_URL: 'https://judge0.internal.example',
    });
    expect(c.speech).toMatchObject({ provider: 'http', url: 'http://127.0.0.1:8765' });
    expect(c.codeExecution).toMatchObject({
      provider: 'judge0',
      languageIds: { javascript: 63, python: 71 },
    });
  });

  it('refuses mock providers in production', () => {
    const problems = problemsOf({
      ...production,
      LLM_PROVIDER: 'mock',
      LLM_MODEL: 'm',
      LLM_API_KEY: 'k',
    });
    expect(problems).toContain('LLM_PROVIDER "mock" is not allowed in production');
  });

  it('caps the session lifetime at 8 hours', () => {
    expect(problemsOf({ ...base, SESSION_TTL_SECONDS: '86400' }).join()).toMatch(/28800/);
  });

  it('parses DEMO_MODE strictly', () => {
    expect(loadConfig({ ...base, DEMO_MODE: 'false' }).demoMode).toBe(false);
    expect(problemsOf({ ...base, DEMO_MODE: 'yes' })).not.toHaveLength(0);
  });

  it('never includes secrets in the startup summary', () => {
    const config = loadConfig({
      ...production,
      LLM_PROVIDER: 'groq',
      LLM_INTERVIEWER_MODEL: 'model-x',
      LLM_EVALUATOR_MODEL: 'model-y',
      LLM_API_KEY: 'sk-super-secret',
      SPEECH_PROVIDER: 'http',
      SPEECH_SERVICE_URL: 'https://speech.internal.example',
      SPEECH_SERVICE_TOKEN: 'speech-token-'.padEnd(40, 'z'),
      CODE_EXECUTION_PROVIDER: 'judge0',
      JUDGE0_URL: 'https://judge0.internal.example',
      JUDGE0_AUTH_TOKEN: 'judge-secret-token',
    });
    const summary = JSON.stringify(describeConfig(config));
    expect(summary).not.toContain('sk-super-secret');
    expect(summary).not.toContain('speech-token');
    expect(summary).not.toContain('judge-secret-token');
    expect(summary).not.toContain('secret@');
  });
});

describe('parseOrigin', () => {
  it('normalises trailing slashes and rejects paths, queries and credentials', () => {
    expect(parseOrigin('https://a.example.com/')).toBe('https://a.example.com');
    expect(parseOrigin('https://a.example.com/x')).toBeNull();
    expect(parseOrigin('https://a.example.com?x=1')).toBeNull();
    expect(parseOrigin('https://u:p@a.example.com')).toBeNull();
    expect(parseOrigin('ftp://a.example.com')).toBeNull();
  });
});
