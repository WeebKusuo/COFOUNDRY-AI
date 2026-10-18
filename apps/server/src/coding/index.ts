import type { CodeExecutionConfig } from '../config/env.js';
import { createReferenceMockJudge } from './grading.js';
import { createDisabledJudge, createJudge0, type CodeJudge } from './judge.js';

export function createCodeJudge(config: CodeExecutionConfig): CodeJudge {
  if (config.provider === 'judge0') {
    return createJudge0({
      url: config.judge0Url!,
      authToken: config.judge0AuthToken,
      languageIds: config.languageIds,
      timeoutMs: config.timeoutMs,
    });
  }
  // Test double (refused in production by config/env.ts); never executes code.
  if (config.provider === 'mock') return createReferenceMockJudge();
  return createDisabledJudge();
}
