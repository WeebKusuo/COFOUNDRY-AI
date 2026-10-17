import type { ReactNode } from 'react';
import { Inbox, Lock, RefreshCw, SearchX, WifiOff } from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';
import { ApiError } from '../../lib/api/client';
import { Button } from './Button';
import { Spinner } from './Spinner';

/**
 * Standard screen states (Section 02): every screen renders loading, empty, forbidden/not-found,
 * validation and retry states. Copy explains what happened and what to do next.
 */

function StateFrame({
  icon,
  title,
  children,
  action,
  role,
}: {
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: 'alert' | 'status';
}) {
  return (
    <div
      className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-line-strong bg-surface px-6 py-8"
      {...(role ? { role } : {})}
    >
      <span className="rounded-lg bg-surface-sunk p-2.5 text-ink-muted">{icon}</span>
      <div>
        <p className="text-lg font-semibold text-ink">{title}</p>
        {children ? <div className="mt-1 max-w-prose text-ink-muted">{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-8 text-ink-muted">
      <Spinner label={null} />
      <span role="status">{label}…</span>
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
  icon,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <StateFrame
      icon={icon ?? <Inbox className="size-5" aria-hidden="true" />}
      title={title}
      action={action}
    >
      {children}
    </StateFrame>
  );
}

export function ErrorState({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const apiError = error instanceof ApiError ? error : null;

  if (apiError?.status === 404 || apiError?.status === 403) {
    // Unrelated resources look identical to missing ones (Section 17: 404 for unrelated).
    const forbidden = apiError.status === 403;
    return (
      <StateFrame
        role="alert"
        icon={
          forbidden ? (
            <Lock className="size-5" aria-hidden="true" />
          ) : (
            <SearchX className="size-5" aria-hidden="true" />
          )
        }
        title={forbidden ? 'You can’t do that here' : 'Not found'}
      >
        {forbidden
          ? 'Your account does not have permission for this action.'
          : 'This page doesn’t exist or isn’t shared with your account.'}
      </StateFrame>
    );
  }

  const offline = apiError?.code === 'NETWORK_ERROR';
  const rateLimited = apiError?.code === 'RATE_LIMITED';
  return (
    <StateFrame
      role="alert"
      icon={
        offline ? (
          <WifiOff className="size-5" aria-hidden="true" />
        ) : (
          <RefreshCw className="size-5" aria-hidden="true" />
        )
      }
      title={
        offline ? 'Can’t reach CoFoundry' : rateLimited ? 'Too many requests' : 'This didn’t load'
      }
      action={
        onRetry && (!apiError || apiError.isRetryable) ? (
          <Button variant="secondary" onClick={onRetry} loading={retrying}>
            Try again
          </Button>
        ) : null
      }
    >
      {apiError?.message ?? 'Something went wrong while loading this page.'}
      {apiError?.retryAfterSeconds ? ` Wait ${apiError.retryAfterSeconds} seconds first.` : null}
      {apiError?.requestId ? (
        <span className="mt-2 block text-xs text-ink-faint">Reference {apiError.requestId}</span>
      ) : null}
    </StateFrame>
  );
}

/**
 * Renders a query's loading / error / empty / success states consistently.
 */
export function QueryState<T>({
  query,
  isEmpty,
  empty,
  loadingLabel,
  children,
}: {
  query: Pick<
    UseQueryResult<T>,
    'data' | 'error' | 'isPending' | 'isError' | 'refetch' | 'isFetching'
  >;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  loadingLabel?: string;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <LoadingState {...(loadingLabel ? { label: loadingLabel } : {})} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const data = query.data as T;
  if (isEmpty?.(data)) return <>{empty}</>;
  return <>{children(data)}</>;
}
