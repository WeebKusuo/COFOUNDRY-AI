import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Lock } from 'lucide-react';
import type { UserRole } from '@cofoundry/shared';
import { homePathFor, useAuth } from '../../lib/auth';
import { ButtonLink, EmptyState, ErrorState, LoadingState } from '../../components/ui';

const ROLE_NAME: Record<UserRole, string> = {
  founder: 'founder',
  candidate: 'candidate',
  moderator: 'moderator',
};

/**
 * Client-side guard for a workspace. It only decides what to render; every API route enforces
 * the same rules on the server (Section 17), so bypassing this guard reveals nothing.
 */
export function RequireRole({ role, children }: { role: UserRole; children: ReactNode }) {
  const { status, user, sessionExpired, signedOut, error, retry } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="grid min-h-dvh place-items-center bg-canvas">
        <LoadingState label="Checking your session" />
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="mx-auto max-w-xl px-4 py-20">
        <ErrorState error={error} onRetry={retry} />
      </div>
    );
  }
  if (!user) {
    // After a deliberate sign-out there is nowhere to return to; after expiry, come back here.
    const params = signedOut
      ? new URLSearchParams({ reason: 'signed-out' })
      : new URLSearchParams({ next: `${location.pathname}${location.search}` });
    if (sessionExpired) params.set('reason', 'expired');
    return <Navigate to={`/sign-in?${params.toString()}`} replace />;
  }
  if (!user.roles.includes(role)) {
    return (
      <main id="main" className="mx-auto max-w-xl px-4 py-20">
        <h1 className="sr-only">Access denied</h1>
        <EmptyState
          icon={<Lock className="size-5" aria-hidden="true" />}
          title={`This is the ${ROLE_NAME[role]} workspace`}
          action={
            <ButtonLink to={homePathFor(user)} variant="secondary">
              Go to your workspace
            </ButtonLink>
          }
        >
          Your account doesn’t have the {ROLE_NAME[role]} role, so you can’t open this area.
        </EmptyState>
      </main>
    );
  }
  return <>{children}</>;
}
