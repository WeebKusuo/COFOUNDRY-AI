import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type BadgeTone = 'neutral' | 'brand' | 'caution' | 'danger' | 'info';

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-surface-sunk text-ink-muted border-line',
  brand: 'bg-brand-soft text-brand-strong border-brand/30 dark:text-brand',
  caution: 'bg-caution-soft text-caution border-caution/30',
  danger: 'bg-danger-soft text-danger border-danger/30',
  info: 'bg-info-soft text-info border-info/30',
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
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium',
        tones[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
