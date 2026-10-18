import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';

export type RoomActivity = 'speaking' | 'listening' | 'thinking' | 'waiting' | 'idle';

const LABELS: Record<RoomActivity, string> = {
  speaking: 'AI interviewer is speaking',
  listening: 'Listening to your answer',
  thinking: 'AI interviewer is thinking',
  waiting: 'Your turn',
  idle: 'Ready',
};

/**
 * Animated voice visualizer for the AI interviewer — no video avatar, no camera. The orb reacts to
 * the live audio level; the text label always states the current activity (never motion alone).
 * Motion is reduced when the user prefers reduced motion.
 */
export function InterviewerAvatar({
  activity,
  level,
}: {
  activity: RoomActivity;
  /** Returns 0-1, sampled every animation frame. */
  level: () => number;
}) {
  const [l, setL] = useState(0);
  const levelRef = useRef(level);
  useEffect(() => {
    levelRef.current = level;
  });
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setL(levelRef.current());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const scale = 1 + Math.min(0.35, l * 0.6);
  return (
    <div className="flex flex-col items-center gap-3" aria-live="polite">
      <div className="relative flex size-40 items-center justify-center sm:size-48">
        <div
          aria-hidden="true"
          className={cn(
            'absolute inset-4 rounded-full border border-line-strong bg-brand-soft/60 transition-transform duration-100 motion-reduce:transition-none',
            activity === 'thinking' && 'animate-pulse',
          )}
          style={{
            transform: `scale(${activity === 'speaking' || activity === 'listening' ? scale : 1})`,
          }}
        />
        <div
          aria-hidden="true"
          className={cn(
            'absolute inset-10 rounded-full border-2 border-ink bg-surface',
            activity === 'thinking' &&
              'border-dashed motion-safe:animate-spin [animation-duration:3s]',
          )}
        />
        <div aria-hidden="true" className="absolute inset-[4.5rem] rounded-full bg-ink" />
      </div>
      <p className="label-mono text-ink-muted" role="status">
        {LABELS[activity]}
      </p>
    </div>
  );
}
