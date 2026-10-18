import { useCallback, useEffect, useRef, useState } from 'react';
import { Video, VideoOff } from 'lucide-react';
import { Alert, Button } from '../../components/ui';
import { isSecureForMedia, mediaErrorState } from './audio';

/**
 * Camera self-view for the interview. The picture is rendered only in the candidate's own
 * browser so they can see themselves, as in a video call. It is never recorded, uploaded, sent
 * to the server or analysed (no face, eye, emotion or cheating detection): the stream is attached
 * to a muted <video> element and nothing else. Turning it on is optional.
 */

export type CameraState =
  | 'off'
  | 'requesting'
  | 'on'
  | 'insecure'
  | 'denied'
  | 'no_device'
  | 'busy'
  | 'unsupported'
  | 'error';

const PREF_KEY = 'cofoundry-camera-self-view';

function readPref(): boolean {
  try {
    return window.sessionStorage.getItem(PREF_KEY) === 'on';
  } catch {
    return false;
  }
}

function writePref(on: boolean) {
  try {
    window.sessionStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* storage unavailable: the preference just is not remembered */
  }
}

export const CAMERA_NOTICE =
  'Only you can see this. Your camera is never recorded, uploaded or analysed.';

export function cameraProblem(state: CameraState): string | null {
  switch (state) {
    case 'insecure':
      return 'Browsers allow the camera only on secure pages. Open the app over https or at http://localhost.';
    case 'denied':
      return 'Camera permission was denied. Allow it for this site to see yourself; the interview works without it.';
    case 'no_device':
      return 'No camera was found. The interview works without it.';
    case 'busy':
      return 'The camera is in use by another app or blocked by the system.';
    case 'unsupported':
      return 'This browser cannot show the camera.';
    case 'error':
      return 'The camera could not be started.';
    default:
      return null;
  }
}

/**
 * Owns one local camera stream for the component that uses it (stopped on unmount). With
 * `resume`, the camera turns on again automatically when the candidate switched it on earlier in
 * this tab (permission is already granted, so there is no new prompt).
 */
export function useCamera(options: { resume?: boolean } = {}) {
  const [state, setState] = useState<CameraState>('off');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /** False after unmount; a request that resolves later is stopped instead of kept. */
  const mounted = useRef(true);
  /** One permission request at a time (StrictMode runs effects twice). */
  const pending = useRef(false);
  /** Bumped by stop(): a request started before "Turn camera off" is discarded. */
  const epoch = useRef(0);

  const stop = useCallback((remember = true) => {
    epoch.current += 1;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
    setState('off');
    if (remember) writePref(false);
  }, []);

  const start = useCallback(async () => {
    if (!isSecureForMedia()) return setState('insecure');
    if (!navigator.mediaDevices?.getUserMedia) return setState('unsupported');
    if (streamRef.current || pending.current) return;
    pending.current = true;
    const myEpoch = epoch.current;
    setState('requesting');
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      if (!mounted.current || epoch.current !== myEpoch || streamRef.current) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = s;
      setStream(s);
      setState('on');
      writePref(true);
    } catch (err) {
      if (mounted.current) setState(mediaErrorState(err));
    } finally {
      pending.current = false;
    }
  }, []);

  const resume = options.resume ?? false;
  useEffect(() => {
    if (resume && readPref()) void start();
  }, [resume, start]);

  // Stop the tracks when the owning component unmounts (keep the preference).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  return { state, stream, start, stop };
}

function SelfVideo({ stream, label }: { stream: MediaStream; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    return () => {
      el.srcObject = null;
    };
  }, [stream]);
  return (
    <video
      ref={ref}
      aria-label={label}
      autoPlay
      muted
      playsInline
      className="aspect-[4/3] w-full -scale-x-100 rounded-xl bg-black object-cover"
    />
  );
}

/** Self-view tile with an on/off control. `compact` is for the room sidebar and coding round. */
export function CameraSelfView({
  resume = false,
  compact = false,
}: {
  resume?: boolean;
  compact?: boolean;
}) {
  const camera = useCamera({ resume });
  const problem = cameraProblem(camera.state);
  return (
    <div className="flex flex-col gap-2">
      {camera.stream ? (
        <SelfVideo stream={camera.stream} label="Your camera (only visible to you)" />
      ) : (
        <div
          className={`flex ${compact ? 'aspect-[4/3]' : 'aspect-video'} w-full items-center justify-center rounded-xl bg-surface-sunk text-ink-muted`}
        >
          <VideoOff className="size-8" aria-hidden="true" />
          <span className="sr-only">Camera off</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {camera.state === 'on' ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<VideoOff className="size-4" aria-hidden="true" />}
            onClick={() => camera.stop()}
          >
            Turn camera off
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            loading={camera.state === 'requesting'}
            icon={<Video className="size-4" aria-hidden="true" />}
            onClick={() => void camera.start()}
          >
            Turn camera on
          </Button>
        )}
      </div>
      <p className="text-xs text-ink-muted">{CAMERA_NOTICE}</p>
      {problem ? (
        <Alert tone="caution" title="Camera unavailable">
          {problem}
        </Alert>
      ) : null}
    </div>
  );
}
