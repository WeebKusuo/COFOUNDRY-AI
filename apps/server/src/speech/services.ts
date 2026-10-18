import { readCapped, readCappedBytes } from '../ai/transport/http-json.js';
import type { SpeechConfig } from '../config/env.js';
import {
  SpeechError,
  speechHealthSchema,
  transcriptionResponseSchema,
  type RawTranscription,
  type SpeechHealth,
  type SpeechServices,
} from './types.js';

/**
 * Clients for the self-hosted Python speech service (services/speech): faster-whisper for
 * speech-to-text and Piper for text-to-speech. Authenticated with a shared bearer token over
 * https or loopback http; the URL comes from configuration only. Audio and text are never
 * logged or stored here.
 */

const MAX_WAV_BYTES = 8 * 1024 * 1024;

export function createHttpSpeechServices(
  config: { url: string; token: string; timeoutMs: number },
  fetchImpl: typeof fetch = fetch,
): SpeechServices {
  const base = new URL(config.url);
  const endpoint = (p: string) => new URL(`${base.pathname.replace(/\/$/, '')}/${p}`, base.origin);
  const auth = { authorization: `Bearer ${config.token}` };

  async function call(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let res: Response;
    try {
      res = await fetchImpl(endpoint(path), { ...init, redirect: 'error', signal: combined });
    } catch {
      if (timeout.aborted)
        throw new SpeechError('timeout', 'The speech service did not answer in time.');
      throw new SpeechError('unavailable', 'The speech service is unreachable.');
    }
    if (res.status === 413 || res.status === 415 || res.status === 422) {
      await res.body?.cancel().catch(() => undefined);
      throw new SpeechError('rejected', 'The speech service could not process this audio.');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new SpeechError('unavailable', `The speech service returned ${res.status}.`);
    }
    return res;
  }

  return {
    stt: {
      providerId: 'faster-whisper',
      configured: true,
      async transcribe(audio, contentType, signal): Promise<RawTranscription> {
        const res = await call(
          'v1/transcribe',
          {
            method: 'POST',
            headers: { ...auth, 'content-type': contentType, 'x-language': 'en' },
            body: new Uint8Array(audio),
          },
          signal,
        );
        let json: unknown;
        try {
          json = JSON.parse(await readCapped(res, 1024 * 1024));
        } catch {
          throw new SpeechError('invalid_output', 'The speech service returned invalid output.');
        }
        const parsed = transcriptionResponseSchema.safeParse(json);
        if (!parsed.success) {
          throw new SpeechError('invalid_output', 'The speech service returned invalid output.');
        }
        return parsed.data;
      },
    },
    tts: {
      providerId: 'piper',
      configured: true,
      async synthesize(text, signal) {
        const res = await call(
          'v1/synthesize',
          {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json', accept: 'audio/wav' },
            body: JSON.stringify({ text }),
          },
          signal,
        );
        if (!(res.headers.get('content-type') ?? '').startsWith('audio/wav')) {
          await res.body?.cancel().catch(() => undefined);
          throw new SpeechError('invalid_output', 'The speech service returned non-audio output.');
        }
        try {
          return await readCappedBytes(res, MAX_WAV_BYTES);
        } catch {
          throw new SpeechError('invalid_output', 'Synthesised audio was too large.');
        }
      },
    },
    async health(signal): Promise<SpeechHealth | null> {
      try {
        const res = await fetchImpl(endpoint('healthz'), {
          headers: auth,
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(3_000)]),
        });
        if (!res.ok) return null;
        const parsed = speechHealthSchema.safeParse(await res.json());
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
  };
}

export function createDisabledSpeechServices(): SpeechServices {
  const fail = async (): Promise<never> => {
    throw new SpeechError('disabled', 'Speech services are not configured.');
  };
  return {
    stt: { providerId: 'disabled', configured: false, transcribe: fail },
    tts: { providerId: 'disabled', configured: false, synthesize: fail },
    health: async () => null,
  };
}

/** A tiny valid silent WAV (mono, 16 kHz, 16-bit) of the given length. */
export function silentWav(seconds: number): Buffer {
  const rate = 16_000;
  const samples = Math.max(1, Math.round(rate * seconds));
  const data = samples * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(data, 40);
  return buf;
}

/**
 * Deterministic test double — FOR AUTOMATED TESTS AND LOCAL E2E ONLY (refused in production).
 * It does not recognise speech: it returns the scripted transcript for the next call (or a
 * fixed sentence) and silent audio for synthesis.
 */
export function createMockSpeechServices(
  script: Array<RawTranscription | Error> = [],
): SpeechServices & { script: Array<RawTranscription | Error>; synthesized: string[] } {
  const synthesized: string[] = [];
  const services = {
    script,
    synthesized,
    stt: {
      providerId: 'mock',
      configured: true,
      async transcribe(audio: Buffer): Promise<RawTranscription> {
        const next = script.shift();
        if (next instanceof Error) throw next;
        if (next) return next;
        const durationSec = Math.min(180, Math.max(1, audio.length / 4000));
        return {
          text: 'I built a REST API in Node.js because the team needed reliable payment exports, and I added retries and tests.',
          language: 'en',
          languageProbability: 0.99,
          durationSec,
          segments: [
            {
              start: 0,
              end: durationSec,
              text: 'I built a REST API in Node.js because the team needed reliable payment exports, and I added retries and tests.',
              avgLogprob: -0.2,
              noSpeechProb: 0.01,
              compressionRatio: 1.3,
            },
          ],
          model: 'mock-stt',
        };
      },
    },
    tts: {
      providerId: 'mock',
      configured: true,
      async synthesize(text: string) {
        synthesized.push(text);
        return silentWav(0.5);
      },
    },
    health: async (): Promise<SpeechHealth> => ({
      status: 'ok',
      stt: { ready: true, model: 'mock-stt' },
      tts: { ready: true, voice: 'mock-voice' },
    }),
  };
  return services;
}

export function createSpeechServices(config: SpeechConfig): SpeechServices {
  if (config.provider === 'http') {
    return createHttpSpeechServices({
      url: config.url!,
      token: config.token!,
      timeoutMs: config.timeoutMs,
    });
  }
  if (config.provider === 'mock') return createMockSpeechServices();
  return createDisabledSpeechServices();
}
