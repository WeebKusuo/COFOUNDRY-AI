import os from 'node:os';
import path from 'node:path';

export const E2E_PORT = 5180;
export const BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_PASSWORD = 'e2e-demo-password-2026';
/** Written by start-server.ts so tests can reach the same database (e.g. to expire sessions). */
export const STATE_FILE = path.join(os.tmpdir(), 'cofoundry-e2e-state.json');

export const ACCOUNTS = {
  founder: 'founder@demo.cofoundry.test',
  candidate: 'asha@demo.cofoundry.test',
  moderator: 'moderator@demo.cofoundry.test',
} as const;
