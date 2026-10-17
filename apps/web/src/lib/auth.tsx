import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  USER_ROLES,
  type LoginData,
  type MeData,
  type SessionUser,
  type UserRole,
} from '@cofoundry/shared';
import { ApiError, api, onUnauthenticated, resetCsrfToken } from './api/client';

/**
 * Client-side session state. The server is authoritative: the cookie is HttpOnly, so the client
 * only learns who is signed in from GET /me, and every route guard here is a convenience on top
 * of server-side checks — never a substitute for them.
 */

export const meQueryKey = ['me'] as const;

export type AuthStatus = 'loading' | 'signed-in' | 'signed-out' | 'error';

interface AuthContextValue {
  status: AuthStatus;
  user: SessionUser | null;
  /** True when a signed-in session ended without the user signing out (expiry, revocation). */
  sessionExpired: boolean;
  /** True right after the user signed out in this tab. */
  signedOut: boolean;
  error: unknown;
  retry: () => void;
  signIn: (email: string, password: string) => Promise<SessionUser>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchMe(signal: AbortSignal): Promise<MeData | null> {
  try {
    return await api.get<MeData>('/me', { signal });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'UNAUTHENTICATED') return null;
    throw err;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [sessionExpired, setSessionExpired] = useState(false);
  const [signedOut, setSignedOut] = useState(false);

  const me = useQuery({
    queryKey: meQueryKey,
    queryFn: ({ signal }) => fetchMe(signal),
    staleTime: 60_000,
    // Re-check periodically and on focus so an expired session is noticed promptly.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: (count, err) => count < 2 && (!(err instanceof ApiError) || err.isRetryable),
  });

  // Any 401 from the API after sign-in — including a background /me check — means the session
  // is gone.
  useEffect(
    () =>
      onUnauthenticated(() => {
        const current = queryClient.getQueryData<MeData | null>(meQueryKey);
        if (!current?.user) return;
        resetCsrfToken();
        queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== meQueryKey[0] });
        queryClient.setQueryData(meQueryKey, null);
        setSignedOut(false);
        setSessionExpired(true);
      }),
    [queryClient],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      const data = (await api.send<LoginData>('POST', '/auth/login', { email, password })) as
        LoginData | undefined;
      if (!data) throw new Error('Empty sign-in response');
      // The server rotated the session and its CSRF token; fetch a new one on the next mutation.
      resetCsrfToken();
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== meQueryKey[0] });
      queryClient.setQueryData<MeData>(meQueryKey, { user: data.user, profileSummaries: [] });
      setSessionExpired(false);
      setSignedOut(false);
      void queryClient.invalidateQueries({ queryKey: meQueryKey });
      return data.user;
    },
    [queryClient],
  );

  const signOut = useCallback(async () => {
    try {
      await api.send('POST', '/auth/logout');
    } catch (err) {
      // Already signed out on the server is fine; anything else is surfaced.
      if (!(err instanceof ApiError) || err.code !== 'UNAUTHENTICATED') throw err;
    } finally {
      resetCsrfToken();
    }
    queryClient.clear();
    queryClient.setQueryData(meQueryKey, null);
    setSessionExpired(false);
    setSignedOut(true);
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(() => {
    const user = me.data?.user ?? null;
    let status: AuthStatus;
    if (me.isPending) status = 'loading';
    else if (me.isError && me.data === undefined) status = 'error';
    else status = user ? 'signed-in' : 'signed-out';
    return {
      status,
      user,
      sessionExpired,
      signedOut,
      error: me.error,
      retry: () => void me.refetch(),
      signIn,
      signOut,
    };
  }, [me, sessionExpired, signedOut, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}

const ROLE_HOME: Record<UserRole, string> = {
  founder: '/founder',
  candidate: '/candidate',
  moderator: '/moderator',
};

/** The workspace a user lands on: the first of their roles in founder, candidate, moderator order. */
export function homePathFor(user: SessionUser): string {
  const role = USER_ROLES.find((r) => user.roles.includes(r));
  return role ? ROLE_HOME[role] : '/';
}

export function workspacePathsFor(user: SessionUser): string[] {
  return USER_ROLES.filter((r) => user.roles.includes(r)).map((r) => ROLE_HOME[r]);
}

/**
 * Validates a post-sign-in redirect: only same-app paths inside a workspace the user can open.
 * Anything else (absolute URLs, //host, other roles' areas) falls back to the user's home.
 */
export function safeRedirect(next: string | null, user: SessionUser): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return homePathFor(user);
  }
  const allowed = workspacePathsFor(user).some((p) => next === p || next.startsWith(`${p}/`));
  return allowed ? next : homePathFor(user);
}
