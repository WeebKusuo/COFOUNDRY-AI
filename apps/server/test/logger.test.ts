import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from '../src/lib/logger.js';

describe('log redaction', () => {
  it('redacts cookies, CSRF tokens, passwords and API keys', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const logger = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink);
    logger.info({
      req: { headers: { cookie: 'sid=abc', 'x-csrf-token': 'tok', authorization: 'Bearer z' } },
      user: { password: 'pw123456789012' },
      llm: { apiKey: 'sk-live' },
    });
    const out = lines.join('');
    for (const secret of ['sid=abc', '"tok"', 'Bearer z', 'pw123456789012', 'sk-live']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[redacted]');
  });
});
