import { Link } from 'react-router';
import { Construction } from 'lucide-react';
import type { UserRole } from '@cofoundry/shared';
import { Card, EmptyState } from '../../components/ui';
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
