import { Link, Outlet } from 'react-router';
import { CONTRACT_VERSION } from '@cofoundry/shared';
import { Logo } from '../brand/Logo';
import { ApiStatus } from './ApiStatus';
import { SkipLink } from './SkipLink';
import { ThemeToggle } from './ThemeToggle';
import { ButtonLink } from '../ui';

export function PublicLayout() {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <SkipLink />
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Logo />
          <nav aria-label="Primary" className="ml-auto flex items-center gap-2 sm:gap-4">
            <a
              href="/#journey"
              className="hidden rounded-md px-2 py-1 text-sm font-medium text-ink-muted hover:text-ink sm:inline"
            >
              How it works
            </a>
            <ThemeToggle />
            <ButtonLink to="/founder" size="sm" variant="secondary" className="max-sm:hidden">
              Preview workspaces
            </ButtonLink>
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>
            CoFoundry AI supports a human decision. Built to Implementation Contract{' '}
            {CONTRACT_VERSION}.
          </p>
          <div className="flex items-center gap-5">
            <ApiStatus />
            <Link to="/design-system" className="rounded hover:text-ink">
              Design system
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
