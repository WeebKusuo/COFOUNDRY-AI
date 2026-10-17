import { cn } from '../../lib/cn';

export interface SpinnerProps {
  size?: 'sm' | 'md';
  /** Accessible label; pass null when the parent already announces the busy state. */
  label?: string | null;
  className?: string;
}

export function Spinner({ size = 'md', label = 'Loading', className }: SpinnerProps) {
  const dim = size === 'sm' ? 'size-4' : 'size-6';
  return (
    <span
      className={cn('inline-flex items-center', className)}
      {...(label ? { role: 'status' } : { 'aria-hidden': true })}
    >
      <svg className={cn(dim, 'animate-spin')} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
