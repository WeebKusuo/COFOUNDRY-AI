import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Browser audio helpers for the interview room. Recorded audio stays in memory until it is
 * uploaded for transcription; nothing is persisted in the browser. (The optional camera
 * self-view lives in camera.ts and is never recorded.)
 */

type Ctor = typeof AudioContext;
function audioContextCtor(): Ctor | null {
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** RMS level 0-1 of an analyser's current time-domain frame. */
function levelOf(analyser: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) {
    const x = (v - 128) / 128;
    sum += x * x;
  }
  return Math.min(1, Math.sqrt(sum / buf.length) * 3);
}

/** Plays synthesized speech through Web Audio and exposes the output level for the avatar. */
export class SpeechPlayer {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private buf = new Uint8Array(new ArrayBuffer(512));

  get supported(): boolean {
    return audioContextCtor() !== null;
  }

  /** Must be called from a user gesture once (autoplay policies). */
  async unlock(): Promise<void> {
    const C = audioContextCtor();
    if (!C) return;
    this.ctx ??= new C();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (!this.analyser) {
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.connect(this.ctx.destination);
    }
  }

  level(): number {
    return this.analyser && this.source ? levelOf(this.analyser, this.buf) : 0;
  }

  async play(data: ArrayBuffer): Promise<void> {
    await this.unlock();
    if (!this.ctx || !this.analyser) throw new Error('Audio output is not supported.');
    this.stop();
    const audio = await this.ctx.decodeAudioData(data.slice(0));
    const source = this.ctx.createBufferSource();
    source.buffer = audio;
    source.connect(this.analyser);
    this.source = source;
    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
    if (this.source === source) this.source = null;
  }

  stop(): void {
    try {
      this.source?.stop();
    } catch {
      /* already stopped */
    }
    this.source = null;
  }
}

export type MicState =
  | 'idle'
  | 'requesting'
  | 'ready'
  /** The page is not a secure context (http on a network address): browsers hide the mic. */
  | 'insecure'
  | 'denied'
  | 'no_device'
  /** Another app or tab is using the device, or the OS blocked it. */
  | 'busy'
  | 'unsupported'
  | 'error';

/** Classifies a getUserMedia failure (shared with the camera). */
export function mediaErrorState(err: unknown): 'denied' | 'no_device' | 'busy' | 'error' {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError')
    return 'denied';
  if (
    name === 'NotFoundError' ||
    name === 'OverconstrainedError' ||
    name === 'DevicesNotFoundError'
  )
    return 'no_device';
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError')
    return 'busy';
  return 'error';
}

/** True when the browser can offer media devices on this page at all. */
export function isSecureForMedia(): boolean {
  return window.isSecureContext !== false;
}

/** What to tell the candidate for each microphone problem (null when nothing is wrong). */
export function micProblem(state: MicState): { title: string; body: string } | null {
  switch (state) {
    case 'insecure':
      return {
        title: 'Microphone blocked by the browser on this address',
        body:
          'Browsers allow the microphone and camera only on secure pages. Open the app over ' +
          'https, or on this computer at http://localhost, then try again.',
      };
    case 'denied':
      return {
        title: 'Microphone permission denied',
        body:
          'Allow microphone access for this site (the icon next to the address bar), then press ' +
          'Test microphone again. You can still type your answers.',
      };
    case 'no_device':
      return {
        title: 'No microphone found',
        body: 'Connect a microphone or headset, then press Test microphone again.',
      };
    case 'busy':
      return {
        title: 'Microphone is in use or blocked by the system',
        body:
          'Close other apps or tabs that use the microphone (calls, recorders) and check your ' +
          'operating system privacy settings, then try again.',
      };
    case 'unsupported':
      return {
        title: 'This browser cannot record audio',
        body: 'Use a current version of Chrome, Edge, Firefox or Safari, or type your answers.',
      };
    case 'error':
      return {
        title: 'Microphone unavailable',
        body: 'The microphone could not be started. Try again, or type your answers.',
      };
    default:
      return null;
  }
}

/** Microphone access with a live input level (for the readiness test and the room). */
export function useMicrophone() {
  const [state, setState] = useState<MicState>('idle');
  const [level, setLevel] = useState(0);
  const levelRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const raf = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
    setLevel(0);
  }, []);

  const request = useCallback(async () => {
    if (!isSecureForMedia()) {
      setState('insecure');
      return null;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setState('unsupported');
      return null;
    }
    if (streamRef.current) return streamRef.current;
    setState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      streamRef.current = stream;
      const C = audioContextCtor();
      if (C) {
        const ctx = new C();
        ctxRef.current = ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Uint8Array(new ArrayBuffer(512));
        let last = 0;
        const tick = (t: number = 0) => {
          levelRef.current = levelOf(analyser, buf);
          // React state (for meters) at ~10 fps; the ref is read every frame by animations.
          if (t - last > 100) {
            last = t;
            setLevel(levelRef.current);
          }
          raf.current = requestAnimationFrame(tick);
        };
        tick();
      }
      setState('ready');
      return stream;
    } catch (err) {
      setState(mediaErrorState(err));
      return null;
    }
  }, []);

  useEffect(() => stop, [stop]);
  const getLevel = useCallback(() => levelRef.current, []);
  return { state, level, getLevel, request, stop, stream: () => streamRef.current };
}

function preferredMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported?.(t)) return t;
  }
  return undefined;
}

/**
 * One answer recording. Stops on demand, at the maximum length, or after a long silence once
 * speech was heard (pauses shorter than that are part of the answer).
 */
export function recordAnswer(
  stream: MediaStream,
  options: { maxSeconds: number; silenceSeconds: number; level: () => number },
): { stop: () => void; done: Promise<Blob> } {
  const mimeType = preferredMime();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  let heard = false;
  let quietSince = Date.now();
  const startedAt = Date.now();
  const timer = window.setInterval(() => {
    const l = options.level();
    if (l > 0.06) {
      heard = true;
      quietSince = Date.now();
    }
    const elapsed = (Date.now() - startedAt) / 1000;
    if (elapsed >= options.maxSeconds) stop();
    else if (heard && (Date.now() - quietSince) / 1000 >= options.silenceSeconds) stop();
  }, 200);
  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => {
      window.clearInterval(timer);
      resolve(new Blob(chunks, { type: (recorder.mimeType || 'audio/webm').split(';')[0] }));
    };
  });
  function stop() {
    if (recorder.state !== 'inactive') recorder.stop();
  }
  recorder.start(1000);
  return { stop, done };
}

// --- Browser voice fallback --------------------------------------------------------------------

/**
 * Reads questions aloud with the browser's built-in speech synthesis when the server voice
 * (Piper) is not available. Only voices that run on this device (`localService`) are used, so
 * question text is not sent to an online voice service.
 */
export class BrowserVoice {
  private speakingSince: number | null = null;

  private synth(): SpeechSynthesis | null {
    return typeof window !== 'undefined' && 'speechSynthesis' in window
      ? window.speechSynthesis
      : null;
  }

  private voice(): SpeechSynthesisVoice | null {
    const voices = this.synth()?.getVoices() ?? [];
    const local = voices.filter((v) => v.localService);
    return (
      local.find((v) => /^en[-_]/i.test(v.lang) && v.default) ??
      local.find((v) => /^en[-_]/i.test(v.lang)) ??
      null
    );
  }

  /** Voices load asynchronously in some browsers; resolves once known (or after 1.5 s). */
  async ready(): Promise<boolean> {
    const synth = this.synth();
    if (!synth) return false;
    if (this.voice()) return true;
    await new Promise<void>((resolve) => {
      const done = () => {
        synth.removeEventListener?.('voiceschanged', done);
        resolve();
      };
      synth.addEventListener?.('voiceschanged', done);
      window.setTimeout(done, 1_500);
    });
    return this.voice() !== null;
  }

  get available(): boolean {
    return this.voice() !== null;
  }

  /** Approximate output level for the avatar animation (synthesis exposes no audio stream). */
  level(): number {
    if (this.speakingSince === null) return 0;
    const t = (Date.now() - this.speakingSince) / 1000;
    return 0.35 + 0.25 * Math.abs(Math.sin(t * 7)) * Math.abs(Math.sin(t * 2.3));
  }

  async speak(text: string): Promise<void> {
    const synth = this.synth();
    if (!synth || !(await this.ready())) throw new Error('No on-device voice is available.');
    this.stop();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = this.voice();
    utterance.lang = utterance.voice?.lang ?? 'en-US';
    utterance.rate = 1;
    await new Promise<void>((resolve, reject) => {
      utterance.onend = () => resolve();
      utterance.onerror = (e) =>
        e.error === 'interrupted' || e.error === 'canceled'
          ? resolve()
          : reject(new Error(e.error));
      this.speakingSince = Date.now();
      synth.speak(utterance);
    }).finally(() => {
      this.speakingSince = null;
    });
  }

  stop(): void {
    this.synth()?.cancel();
    this.speakingSince = null;
  }
}
