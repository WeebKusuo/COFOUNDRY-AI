import { z } from 'zod';
import type { TranscriptConfidence, TranscriptSegmentView } from '@cofoundry/shared';

/**
 * Speech interfaces (Phase 8), separate from the LLM capability registry:
 *  - SpeechToText: Whisper (faster-whisper) in the self-hosted Python speech service.
 *  - TextToSpeech: Piper in the same service.
 * Raw audio is passed through in memory and never stored by the backend.
 */

export type SpeechErrorCode =
  'disabled' | 'timeout' | 'unavailable' | 'rejected' | 'invalid_output';

export class SpeechError extends Error {
  readonly code: SpeechErrorCode;
  constructor(code: SpeechErrorCode, message: string) {
    super(message);
    this.name = 'SpeechError';
    this.code = code;
  }
}

export const rawSegmentSchema = z.strictObject({
  start: z.number().min(0),
  end: z.number().min(0),
  text: z.string().max(5_000),
  avgLogprob: z.number(),
  noSpeechProb: z.number().min(0).max(1),
  compressionRatio: z.number().min(0),
});
export type RawSegment = z.infer<typeof rawSegmentSchema>;

export const transcriptionResponseSchema = z.strictObject({
  text: z.string().max(20_000),
  language: z.string().max(16),
  languageProbability: z.number().min(0).max(1),
  durationSec: z.number().min(0),
  segments: z.array(rawSegmentSchema).max(500),
  model: z.string().max(100),
});
export type RawTranscription = z.infer<typeof transcriptionResponseSchema>;

export const speechHealthSchema = z.strictObject({
  status: z.literal('ok'),
  stt: z.strictObject({ ready: z.boolean(), model: z.string().max(100).nullable() }),
  tts: z.strictObject({ ready: z.boolean(), voice: z.string().max(100).nullable() }),
});
export type SpeechHealth = z.infer<typeof speechHealthSchema>;

export interface SpeechToText {
  readonly providerId: string;
  readonly configured: boolean;
  transcribe(audio: Buffer, contentType: string, signal: AbortSignal): Promise<RawTranscription>;
}

export interface TextToSpeech {
  readonly providerId: string;
  readonly configured: boolean;
  /** WAV bytes. */
  synthesize(text: string, signal: AbortSignal): Promise<Buffer>;
}

export interface SpeechServices {
  stt: SpeechToText;
  tts: TextToSpeech;
  /** Live readiness of the speech service (cached briefly by callers). */
  health(signal: AbortSignal): Promise<SpeechHealth | null>;
}

// --- Deterministic transcript analysis -----------------------------------------------------------

/**
 * Thresholds follow Whisper's own conventions: a segment with high no-speech probability and low
 * average log-probability is silence/noise, and a very high compression ratio indicates the
 * repetitive output Whisper produces when it "hallucinates". Such segments are DROPPED and shown
 * as "[unclear audio]" — the text is never kept or guessed. Low log-probability marks the words
 * as uncertain so the candidate can correct them and the evaluator knows recognition may be
 * wrong.
 */
export const TRANSCRIPT_THRESHOLDS = {
  noSpeechProb: 0.6,
  silenceLogprob: -1.0,
  maxCompressionRatio: 2.4,
  uncertainLogprob: -0.7,
  highConfidenceMeanLogprob: -0.5,
  lowConfidenceBadShare: 0.3,
} as const;

export const UNCLEAR_MARKER = '[unclear audio]';

export interface AnalysedTranscript {
  text: string;
  segments: TranscriptSegmentView[];
  confidence: TranscriptConfidence;
  noSpeech: boolean;
  durationSec: number;
  uncertainSegments: number;
}

export function analyseTranscript(raw: RawTranscription): AnalysedTranscript {
  const t = TRANSCRIPT_THRESHOLDS;
  const segments: TranscriptSegmentView[] = [];
  let keptDuration = 0;
  let badDuration = 0;
  let logprobWeighted = 0;
  for (const s of raw.segments) {
    const duration = Math.max(0, s.end - s.start);
    const text = s.text.replace(/\s+/g, ' ').trim();
    const silent = s.noSpeechProb > t.noSpeechProb && s.avgLogprob < t.silenceLogprob;
    const hallucinated = s.compressionRatio > t.maxCompressionRatio;
    if (text === '' && !silent) continue;
    if (silent || hallucinated) {
      // Pure silence is dropped quietly; unclear speech is marked so nothing is invented.
      if (!silent || text !== '') {
        segments.push({
          text: UNCLEAR_MARKER,
          startSec: s.start,
          endSec: s.end,
          uncertain: true,
          dropped: true,
        });
        badDuration += duration;
      }
      continue;
    }
    const uncertain = s.avgLogprob < t.uncertainLogprob;
    if (uncertain) badDuration += duration;
    keptDuration += duration;
    logprobWeighted += s.avgLogprob * duration;
    segments.push({ text, startSec: s.start, endSec: s.end, uncertain, dropped: false });
  }
  // Collapse consecutive unclear markers.
  const collapsed: TranscriptSegmentView[] = [];
  for (const seg of segments) {
    const prev = collapsed[collapsed.length - 1];
    if (prev?.dropped && seg.dropped) {
      prev.endSec = seg.endSec;
      continue;
    }
    collapsed.push({ ...seg });
  }
  const kept = collapsed.filter((s) => !s.dropped);
  const noSpeech = kept.length === 0;
  const total = keptDuration + badDuration;
  const badShare = total === 0 ? 1 : badDuration / total;
  const meanLogprob = keptDuration === 0 ? -Infinity : logprobWeighted / keptDuration;
  const confidence: TranscriptConfidence = noSpeech
    ? 'low'
    : badShare === 0 && meanLogprob > t.highConfidenceMeanLogprob
      ? 'high'
      : badShare > t.lowConfidenceBadShare
        ? 'low'
        : 'medium';
  return {
    text: noSpeech
      ? ''
      : collapsed
          .map((s) => s.text)
          .join(' ')
          .trim(),
    segments: collapsed,
    confidence,
    noSpeech,
    durationSec: raw.durationSec,
    uncertainSegments: collapsed.filter((s) => s.uncertain).length,
  };
}

/** Share of words changed between the speech-to-text output and the submitted text, 0-1. */
export function editRatio(original: string, edited: string): number {
  const a = original.toLowerCase().split(/\s+/).filter(Boolean);
  const b = edited.toLowerCase().split(/\s+/).filter(Boolean);
  if (a.length === 0 && b.length === 0) return 0;
  // Word-level Levenshtein distance, bounded by the 4,000-character answer limit.
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return Math.min(1, prev[b.length]! / Math.max(a.length, b.length));
}
