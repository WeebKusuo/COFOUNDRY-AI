import { Link } from 'react-router';
import { Construction } from 'lucide-react';
import type { UserRole } from '@cofoundry/shared';
import { Badge, ButtonLink, Card, EmptyState } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { WORKSPACES, workspaceHref, type NavItem } from './nav';

function PageHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-8 max-w-3xl">
      <h1 className="text-2xl font-bold text-ink sm:text-3xl">{title}</h1>
      <p className="mt-2 text-ink-muted">{description}</p>
    </div>
  );
}

/** Workspace overview: what each area will do, with links to the planned screens. */
export function WorkspaceHome({ role }: { role: UserRole }) {
  const def = WORKSPACES[role];
  const areas = def.nav.filter((n) => n.path !== '');
  return (
    <>
      <PageHeader title={def.title} description={def.summary} />
      {role !== 'moderator' ? <ProfileStatus role={role} /> : null}
      <h2 className="mb-3 text-lg font-semibold text-ink">Areas in this workspace</h2>
      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {areas.map((item) => {
          const Icon = item.icon;
          return (
            <Card as="li" key={item.path} className="relative flex flex-col gap-2 shadow-none">
              <Icon className="size-5 text-brand" aria-hidden="true" />
              <h3 className="font-semibold text-ink">
                <Link
                  to={workspaceHref(def, item)}
                  className="rounded after:absolute after:inset-0 hover:underline"
                >
                  {item.label}
                </Link>
              </h3>
              <p className="text-sm text-ink-muted">{item.purpose}</p>
            </Card>
          );
        })}
      </ul>
    </>
  );
}

function ProfileStatus({ role }: { role: 'founder' | 'candidate' }) {
  const { profileSummaries } = useAuth();
  const summary = profileSummaries.find((p) => p.role === role);
  const href = `${WORKSPACES[role].basePath}/profile`;
  return (
    <Card
      as="section"
      aria-label="Profile status"
      className="mb-8 flex flex-wrap items-center justify-between gap-4 shadow-none"
    >
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold text-ink">Your profile</h2>
          <Badge tone={summary?.complete ? 'brand' : 'caution'}>
            {!summary ? 'Not started' : summary.complete ? 'Complete' : 'Incomplete'}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-ink-muted">
          {role === 'candidate'
            ? 'A complete profile is required before you can turn on discovery.'
            : 'Candidates see your bio and company link next to your briefs.'}
        </p>
      </div>
      <ButtonLink to={href} variant="secondary" size="sm">
        {summary ? 'Edit profile' : 'Create profile'}
      </ButtonLink>
    </Card>
  );
}

/** A required screen whose functionality lands in a later phase — stated plainly, no dead buttons. */
export function PlannedScreen({ role, item }: { role: UserRole; item: NavItem }) {
  const def = WORKSPACES[role];
  return (
    <>
      <PageHeader title={item.label} description={item.purpose} />
      <EmptyState
        icon={<Construction className="size-5" aria-hidden="true" />}
        title="Not available yet"
      >
        This screen is part of the {def.title.toLowerCase()} and is built in a later phase. Its
        navigation, layout and states are in place now.
      </EmptyState>
    </>
  );
}
