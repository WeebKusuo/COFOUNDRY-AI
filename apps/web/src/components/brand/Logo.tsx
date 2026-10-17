import { Link } from 'react-router';
import { cn } from '../../lib/cn';

/**
 * Wordmark. The glyph is two blocks: the founder's existing team (C) and the missing piece the
 * product helps find (the signal-yellow block).
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-8', className)} aria-hidden="true">
      <rect width="32" height="32" rx="7" className="fill-brand" />
      <path d="M9 11.5h7.5v3H12v3h4.5v3H9z" className="fill-canvas" />
      <path d="M18.5 11.5H23v9h-4.5z" className="fill-signal" />
    </svg>
  );
}

export function Logo({ to = '/', className }: { to?: string; className?: string }) {
  return (
    <Link
      to={to}
      className={cn(
        'inline-flex shrink-0 items-center gap-2.5 rounded-md whitespace-nowrap text-ink',
        className,
      )}
      aria-label="CoFoundry AI home"
    >
      <LogoMark />
      <span className="text-lg font-bold tracking-tight">
        CoFoundry <span className="font-medium text-ink-muted">AI</span>
      </span>
    </Link>
  );
}
