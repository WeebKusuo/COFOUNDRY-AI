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
    expect(config.llm).toEqual({ provider: 'disabled', model: null, apiKey: null });
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

  it('requires model and key when an LLM provider is enabled', () => {
    const problems = problemsOf({ ...base, LLM_PROVIDER: 'openai' });
    expect(problems).toHaveLength(2);
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
      LLM_PROVIDER: 'openai',
      LLM_MODEL: 'model-x',
      LLM_API_KEY: 'sk-super-secret',
    });
    const summary = JSON.stringify(describeConfig(config));
    expect(summary).not.toContain('sk-super-secret');
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
