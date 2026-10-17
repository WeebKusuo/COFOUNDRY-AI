import { useEffect, useId, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { LogOut, Menu, X } from 'lucide-react';
import { USER_ROLES, type SessionUser } from '@cofoundry/shared';
import { useAuth } from '../../lib/auth';
import { Badge, Button } from '../ui';
import { Logo } from '../brand/Logo';
import { cn } from '../../lib/cn';
import { WORKSPACES, workspaceHref, type WorkspaceDefinition } from '../../features/workspace/nav';
import { ApiStatus } from './ApiStatus';
import { SkipLink } from './SkipLink';
import { ThemeToggle } from './ThemeToggle';

const ROLE_LABEL = { founder: 'Founder', candidate: 'Candidate', moderator: 'Moderator' } as const;

function SideNav({
  def,
  user,
  onNavigate,
}: {
  def: WorkspaceDefinition;
  user: SessionUser;
  onNavigate?: () => void;
}) {
  const otherRoles = USER_ROLES.filter((r) => r !== def.role && user.roles.includes(r));
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
      {otherRoles.length > 0 ? (
        <div className="border-t border-line pt-4">
          <p className="px-3 text-xs font-semibold text-ink-faint">Your other workspaces</p>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {otherRoles.map((role) => (
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
      ) : null}
    </nav>
  );
}

function SignOutButton({ compact = false }: { compact?: boolean }) {
  const { signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const onClick = async () => {
    setBusy(true);
    setFailed(false);
    try {
      // The route guard then redirects to the sign-in page with a "signed out" notice.
      await signOut();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      {failed ? (
        <span role="alert" className="text-sm text-danger">
          Couldn’t sign out. Try again.
        </span>
      ) : null}
      <Button
        variant={compact ? 'secondary' : 'ghost'}
        size="sm"
        loading={busy}
        onClick={onClick}
        icon={<LogOut className="size-4" aria-hidden="true" />}
      >
        Sign out
      </Button>
    </span>
  );
}

/**
 * Signed-in application frame shared by founder, candidate and moderator workspaces. Rendered
 * only inside <RequireRole>, so a user is always present.
 */
export function AppShell({ role }: { role: keyof typeof WORKSPACES }) {
  const def = WORKSPACES[role];
  const { user } = useAuth();
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

  if (!user) return null; // RequireRole renders the shell only for a signed-in user.

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
          <div className="ml-auto flex items-center gap-3">
            <ApiStatus className="hidden xl:inline-flex" />
            <ThemeToggle className="max-sm:hidden" />
            <span className="hidden text-right leading-tight md:block">
              <span className="block text-sm font-semibold text-ink">{user.displayName}</span>
              <span className="block text-xs text-ink-muted">{user.email}</span>
            </span>
            <span className="max-sm:hidden">
              <SignOutButton />
            </span>
          </div>
        </div>
        {user.accountMode === 'demo' ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line bg-caution-soft px-4 py-2 text-sm text-ink sm:px-6">
            <Badge tone="caution">Demo account</Badge>
            <span>This is a shared, seeded identity. Don’t enter real personal information.</span>
          </div>
        ) : null}
        {menuOpen ? (
          <div
            id={menuId}
            className="max-h-[70dvh] overflow-y-auto border-t border-line bg-surface px-3 py-4 lg:hidden"
          >
            <SideNav def={def} user={user} onNavigate={() => setMenuOpen(false)} />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line px-3 pt-4 sm:hidden">
              <span className="text-sm">
                <span className="block font-semibold text-ink">{user.displayName}</span>
                <span className="block text-xs text-ink-muted">{user.email}</span>
              </span>
              <ThemeToggle />
              <SignOutButton compact />
            </div>
          </div>
        ) : null}
      </header>

      <div className="mx-auto flex max-w-[1400px]">
        <aside className="sticky top-28 hidden h-[calc(100dvh-7rem)] w-64 shrink-0 overflow-y-auto border-r border-line px-3 py-6 lg:block">
          <SideNav def={def} user={user} />
        </aside>

        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-8 sm:px-8 lg:px-12">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
