import { useHealth } from '../../lib/api/hooks';
import { cn } from '../../lib/cn';

/** Live API liveness from GET /api/v1/health — proves the same-origin integration end to end. */
export function ApiStatus({ className }: { className?: string }) {
  const health = useHealth();
  const state = health.isPending ? 'checking' : health.isSuccess ? 'online' : 'offline';
  const text = {
    checking: 'Checking service',
    online: 'Service online',
    offline: 'Service unreachable',
  }[state];
  return (
    <span
      role="status"
      className={cn('inline-flex items-center gap-2 text-sm text-ink-muted', className)}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-2 rounded-full',
          state === 'online' && 'bg-success',
          state === 'offline' && 'bg-danger',
          state === 'checking' && 'bg-line-strong',
        )}
      />
      {text}
    </span>
  );
}
