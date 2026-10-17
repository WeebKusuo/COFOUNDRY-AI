import type { RouteObject } from 'react-router';
import { USER_ROLES } from '@cofoundry/shared';
import { AppShell } from '../components/layout/AppShell';
import { PublicLayout } from '../components/layout/PublicLayout';
import { LandingPage } from '../features/landing/LandingPage';
import { DesignSystemPage } from '../features/design-system/DesignSystemPage';
import { NotFoundPage } from '../features/NotFoundPage';
import { WORKSPACES } from '../features/workspace/nav';
import { PlannedScreen, WorkspaceHome } from '../features/workspace/WorkspacePages';

/**
 * Route table. Workspace routes are generated from the navigation config so every nav item has a
 * reachable screen. Phase 2 wraps the workspace routes in an authenticated, role-checked guard.
 */
export const routes: RouteObject[] = [
  {
    element: <PublicLayout />,
    children: [
      { index: true, element: <LandingPage /> },
      { path: 'design-system', element: <DesignSystemPage /> },
    ],
  },
  ...USER_ROLES.map((role): RouteObject => ({
    path: WORKSPACES[role].basePath,
    element: <AppShell role={role} />,
    children: WORKSPACES[role].nav.map((item) =>
      item.path === ''
        ? { index: true, element: <WorkspaceHome role={role} /> }
        : { path: item.path, element: <PlannedScreen role={role} item={item} /> },
    ),
  })),
  {
    element: <PublicLayout />,
    children: [{ path: '*', element: <NotFoundPage /> }],
  },
];
