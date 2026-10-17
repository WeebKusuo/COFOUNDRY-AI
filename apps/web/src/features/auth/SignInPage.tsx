import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { ApiError } from '../../lib/api/client';
import { safeRedirect, useAuth } from '../../lib/auth';
import { Logo } from '../../components/brand/Logo';
import { ThemeToggle } from '../../components/layout/ThemeToggle';
import { SkipLink } from '../../components/layout/SkipLink';
import { Alert, Button, LoadingState, TextField } from '../../components/ui';

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'RATE_LIMITED') {
      const minutes = err.retryAfterSeconds ? Math.ceil(err.retryAfterSeconds / 60) : 15;
      return `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
    }
    if (err.code === 'UNAUTHENTICATED') return 'Email or password is incorrect.';
    if (err.code === 'NETWORK_ERROR') return err.message;
    if (err.code === 'VALIDATION_FAILED') return 'Check the email and password and try again.';
  }
  return 'Sign-in failed. Try again in a moment.';
}

/**
 * Section 02 sign-in: seeded accounts only, generic invalid-credentials message, explains that
 * demo accounts are shared identities. No sign-up, verification or password reset exists.
 */
export function SignInPage() {
  const { status, user, signIn, sessionExpired, signedOut } = useAuth();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});

  const reason =
    params.get('reason') ?? (sessionExpired ? 'expired' : signedOut ? 'signed-out' : null);
  const next = params.get('next');

  if (status === 'loading') {
    return (
      <div className="grid min-h-dvh place-items-center bg-canvas">
        <LoadingState label="Checking your session" />
      </div>
    );
  }
  if (status === 'signed-in' && user) {
    return <Navigate to={safeRedirect(next, user)} replace />;
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errs: typeof fieldErrors = {};
    if (!email.trim()) errs.email = 'Enter your email address.';
    if (!password) errs.password = 'Enter your password.';
    setFieldErrors(errs);
    setError(null);
    if (errs.email || errs.password) return;

    setSubmitting(true);
    try {
      // On success the session state updates and the signed-in branch above redirects; navigating
      // here directly would race the auth state and briefly bounce through the route guard.
      await signIn(email.trim(), password);
    } catch (err) {
      setError(errorMessage(err));
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid min-h-dvh bg-canvas lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <SkipLink />
      <aside
        aria-label="About CoFoundry accounts"
        className="relative hidden flex-col justify-between overflow-hidden bg-[#0a3d35] p-12 text-white lg:flex"
      >
        <span
          aria-hidden="true"
          className="absolute -right-16 top-24 h-64 w-40 rounded-3xl bg-signal/90"
        />
        <span
          aria-hidden="true"
          className="absolute -right-40 top-24 h-64 w-40 rounded-3xl bg-white/10"
        />
        <span aria-hidden="true" />
        <div className="relative max-w-md">
          <h2 className="text-3xl leading-tight font-bold">
            The missing piece is a person. Meet them on clear terms.
          </h2>
          <ul className="mt-8 space-y-4 text-white/85">
            <li>Every match score shows the factors behind it.</li>
            <li>Interview reports show the original answers to both people.</li>
            <li>Trial sprints are capped at 10 hours and need both approvals.</li>
          </ul>
        </div>
        <p className="relative text-sm text-white/70">
          Your session ends after 30 minutes without activity, and after 8 hours at most.
        </p>
      </aside>

      <div className="flex flex-col">
        <header className="flex h-16 items-center justify-between px-4 sm:px-8">
          <Logo />
          <ThemeToggle />
        </header>
        <main
          id="main"
          tabIndex={-1}
          className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8"
        >
          <div className="w-full max-w-md">
            <h1 className="text-3xl font-bold text-ink">Sign in</h1>
            <p className="mt-2 text-ink-muted">Use the account your organiser gave you.</p>

            <div className="mt-6 flex flex-col gap-3">
              {reason === 'expired' ? (
                <Alert tone="caution" title="Your session ended">
                  For your security you were signed out. Sign in again to continue.
                </Alert>
              ) : null}
              {reason === 'signed-out' ? <Alert tone="success" title="You signed out" /> : null}
              {error ? <Alert tone="danger" title={error} live /> : null}
            </div>

            <form noValidate onSubmit={onSubmit} className="mt-6 flex flex-col gap-5">
              <TextField
                label="Email"
                type="email"
                name="email"
                autoComplete="username"
                inputMode="email"
                spellCheck={false}
                required
                value={email}
                error={fieldErrors.email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <div className="flex flex-col gap-1.5">
                <TextField
                  label="Password"
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  error={fieldErrors.password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="self-start rounded text-sm font-medium text-brand hover:underline"
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? 'Hide password' : 'Show password'}
                </button>
              </div>
              <Button type="submit" size="lg" loading={submitting}>
                Sign in
              </Button>
            </form>

            <div className="mt-8 space-y-2 border-t border-line pt-6 text-sm text-ink-muted">
              <p>
                <strong className="font-semibold text-ink">Demo accounts are shared.</strong> Anyone
                with the demo password can open them, so never enter real personal information.
              </p>
              <p>Accounts are provided by the organiser. There is no sign-up or password reset.</p>
              <p className="lg:hidden">
                Your session ends after 30 minutes without activity, and after 8 hours at most.
              </p>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
