import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type BadgeTone = 'neutral' | 'brand' | 'caution' | 'danger' | 'info';

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-transparent text-ink-muted border-line-strong',
  brand: 'bg-transparent text-ink border-ink',
  caution: 'bg-caution-soft text-caution border-caution/40',
  danger: 'bg-danger-soft text-danger border-danger/40',
  info: 'bg-info-soft text-info border-info/40',
};

/**
 * Status label. The text always carries the meaning — tone is reinforcement only, never the sole
 * signal (e.g. "Provisional", "Self-reported link", "Seeded demo data").
 */
export function Badge({
  tone = 'neutral',
  icon,
  children,
  className,
}: {
  tone?: BadgeTone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'label-mono inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5',
        tones[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
