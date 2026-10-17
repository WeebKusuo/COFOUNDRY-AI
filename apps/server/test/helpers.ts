import type { AppConfig } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';

export const TEST_ORIGIN = 'http://localhost:5173';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    env: 'test',
    isProduction: false,
    port: 0,
    internalPort: 0,
    appOrigin: TEST_ORIGIN,
    mongodbUri: 'mongodb://127.0.0.1:27017/cofoundry-test',
    sessionTtlSeconds: 28_800,
    llm: { provider: 'disabled', model: null, apiKey: null },
    demoMode: true,
    logLevel: 'silent',
    trustProxyHops: 0,
    serveWeb: false,
    webDistDir: '/nonexistent',
    ...overrides,
  };
}

export const silentLogger = createLogger('silent');
