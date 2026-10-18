import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpSpeechServices, silentWav } from '../src/speech/services.js';
import { SpeechError } from '../src/speech/types.js';

/**
 * The backend's client for the Python speech service (services/speech), against a local stub
 * with the same HTTP contract. The real service's own tests live in services/speech/tests.
 */

const TOKEN = 't'.repeat(40);
let server: http.Server;
let url: string;
let mode = 'ok';
const seen: Array<{ path: string; auth?: string; type?: string; lang?: string; bytes: number }> =
  [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({
        path: req.url ?? '',
        auth: req.headers.authorization,
        type: req.headers['content-type'],
        lang: req.headers['x-language'] as string | undefined,
        bytes: body.length,
      });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401;
        return res.end('{}');
      }
      if (req.url === '/speech/healthz') {
        res.setHeader('content-type', 'application/json');
        return res.end(
          JSON.stringify({
            status: 'ok',
            stt: { ready: true, model: 'small.en' },
            tts: { ready: true, voice: 'en_US-ljspeech-medium' },
          }),
        );
      }
      if (req.url === '/speech/v1/transcribe') {
        if (mode === 'reject') {
          res.statusCode = 415;
          return res.end('{}');
        }
        res.setHeader('content-type', 'application/json');
        if (mode === 'bad') return res.end(JSON.stringify({ text: 'hi', extra: true }));
        return res.end(
          JSON.stringify({
            text: 'hello',
            language: 'en',
            languageProbability: 0.99,
            durationSec: 1.2,
            segments: [
              {
                start: 0,
                end: 1.2,
                text: 'hello',
                avgLogprob: -0.2,
                noSpeechProb: 0.01,
                compressionRatio: 1.1,
              },
            ],
            model: 'small.en',
          }),
        );
      }
      if (req.url === '/speech/v1/synthesize') {
        res.setHeader('content-type', 'audio/wav');
        return res.end(silentWav(0.2));
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/speech`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const services = (token = TOKEN) => createHttpSpeechServices({ url, token, timeoutMs: 5000 });

describe('speech service client', () => {
  it('sends raw audio with the bearer token and validates the transcript', async () => {
    mode = 'ok';
    const result = await services().stt.transcribe(
      Buffer.alloc(1234, 1),
      'audio/webm',
      AbortSignal.timeout(5000),
    );
    expect(result.segments[0]).toMatchObject({ text: 'hello', avgLogprob: -0.2 });
    expect(seen.at(-1)).toMatchObject({
      path: '/speech/v1/transcribe',
      auth: `Bearer ${TOKEN}`,
      type: 'audio/webm',
      lang: 'en',
      bytes: 1234,
    });
  });

  it('returns synthesized WAV bytes unchanged', async () => {
    const wav = await services().tts.synthesize('Hello', AbortSignal.timeout(5000));
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.length).toBe(silentWav(0.2).length);
  });

  it('rejects malformed transcripts and reports refusals and auth failures as errors', async () => {
    mode = 'bad';
    await expect(
      services().stt.transcribe(Buffer.alloc(10), 'audio/webm', AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({ code: 'invalid_output' });
    mode = 'reject';
    await expect(
      services().stt.transcribe(Buffer.alloc(10), 'audio/webm', AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({ code: 'rejected' });
    await expect(
      services('wrong'.repeat(10)).tts.synthesize('x', AbortSignal.timeout(5000)),
    ).rejects.toBeInstanceOf(SpeechError);
  });

  it('reports health, or null when unreachable', async () => {
    expect(await services().health(AbortSignal.timeout(5000))).toMatchObject({
      stt: { ready: true },
      tts: { voice: 'en_US-ljspeech-medium' },
    });
    const down = createHttpSpeechServices({
      url: 'http://127.0.0.1:9/x',
      token: TOKEN,
      timeoutMs: 500,
    });
    expect(await down.health(AbortSignal.timeout(2000))).toBeNull();
    await expect(
      down.stt.transcribe(Buffer.alloc(1), 'audio/wav', AbortSignal.timeout(2000)),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
});
