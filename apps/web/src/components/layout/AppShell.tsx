import { useEffect, useId, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { Menu, X } from 'lucide-react';
import { USER_ROLES } from '@cofoundry/shared';
import { Logo } from '../brand/Logo';
import { cn } from '../../lib/cn';
import { WORKSPACES, workspaceHref, type WorkspaceDefinition } from '../../features/workspace/nav';
import { ApiStatus } from './ApiStatus';
import { SkipLink } from './SkipLink';
import { ThemeToggle } from './ThemeToggle';

const ROLE_LABEL = { founder: 'Founder', candidate: 'Candidate', moderator: 'Moderator' } as const;

function SideNav({ def, onNavigate }: { def: WorkspaceDefinition; onNavigate?: () => void }) {
  return (
    <nav aria-label={`${ROLE_LABEL[def.role]} navigation`} className="flex flex-col gap-6">
      <ul className="flex flex-col gap-0.5">
        {def.nav.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.path}>
              <NavLink
                to={workspaceHref(def, item)}
                end={item.path === ''}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-brand-soft text-ink'
                      : 'text-ink-muted hover:bg-surface-sunk hover:text-ink',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon
                      className={cn('size-4', isActive ? 'text-brand' : 'text-ink-faint')}
                      aria-hidden="true"
                    />
                    {item.label}
                  </>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-line pt-4">
        <p className="px-3 text-xs font-semibold text-ink-faint">Other workspace previews</p>
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {USER_ROLES.filter((r) => r !== def.role).map((role) => (
            <li key={role}>
              <NavLink
                to={WORKSPACES[role].basePath}
                onClick={onNavigate}
                className="block rounded-lg px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-sunk hover:text-ink"
              >
                {ROLE_LABEL[role]}
              </NavLink>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

/**
 * Authenticated application frame shared by founder, candidate and moderator workspaces.
 * Phase 1 renders it as a preview: no session exists yet, and a banner says so.
 */
export function AppShell({ role }: { role: keyof typeof WORKSPACES }) {
  const def = WORKSPACES[role];
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const location = useLocation();

  // Close the mobile menu on navigation and on Escape.
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <div className="min-h-dvh bg-canvas">
      <SkipLink />
      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
          <button
            type="button"
            className="inline-flex size-10 items-center justify-center rounded-lg text-ink hover:bg-surface-sunk lg:hidden"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
            onClick={() => setMenuOpen((v) => !v)}
          >
            {menuOpen ? (
              <X className="size-5" aria-hidden="true" />
            ) : (
              <Menu className="size-5" aria-hidden="true" />
            )}
          </button>
          <Logo />
          <span className="hidden rounded-md border border-line px-2 py-0.5 text-xs font-semibold text-ink-muted sm:inline">
            {ROLE_LABEL[role]}
          </span>
          <div className="ml-auto flex items-center gap-4">
            <ApiStatus className="hidden md:inline-flex" />
            <ThemeToggle className="max-sm:hidden" />
          </div>
        </div>
        <div className="border-t border-line bg-caution-soft px-4 py-2 text-sm text-ink sm:px-6">
          <strong className="font-semibold">Workspace preview.</strong> Sign-in and stored data
          arrive in a later phase; nothing on these pages is saved.
        </div>
        {menuOpen ? (
          <div
            id={menuId}
            className="max-h-[70dvh] overflow-y-auto border-t border-line bg-surface px-3 py-4 lg:hidden"
          >
            <SideNav def={def} onNavigate={() => setMenuOpen(false)} />
            <div className="mt-4 flex items-center justify-between border-t border-line px-3 pt-4 sm:hidden">
              <ApiStatus />
              <ThemeToggle />
            </div>
          </div>
        ) : null}
      </header>

      <div className="mx-auto flex max-w-[1400px]">
        <aside className="sticky top-28 hidden h-[calc(100dvh-7rem)] w-64 shrink-0 overflow-y-auto border-r border-line px-3 py-6 lg:block">
          <SideNav def={def} />
        </aside>

        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-8 sm:px-8 lg:px-12">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
