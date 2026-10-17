import type { RouteObject } from 'react-router';
import { USER_ROLES } from '@cofoundry/shared';
import { AppShell } from '../components/layout/AppShell';
import { PublicLayout } from '../components/layout/PublicLayout';
import { LandingPage } from '../features/landing/LandingPage';
import { DesignSystemPage } from '../features/design-system/DesignSystemPage';
import { NotFoundPage } from '../features/NotFoundPage';
import { WORKSPACES } from '../features/workspace/nav';
import { PlannedScreen, WorkspaceHome } from '../features/workspace/WorkspacePages';
import { SignInPage } from '../features/auth/SignInPage';
import { RequireRole } from '../features/auth/RequireRole';

/**
 * Route table. Workspace routes are generated from the navigation config so every nav item has a
 * reachable screen. Workspaces render only for a signed-in user holding that role; the server
 * enforces the same rules on every API route.
 */
export const routes: RouteObject[] = [
  {
    element: <PublicLayout />,
    children: [
      { index: true, element: <LandingPage /> },
      { path: 'design-system', element: <DesignSystemPage /> },
    ],
  },
  { path: '/sign-in', element: <SignInPage /> },
  ...USER_ROLES.map((role): RouteObject => ({
    path: WORKSPACES[role].basePath,
    element: (
      <RequireRole role={role}>
        <AppShell role={role} />
      </RequireRole>
    ),
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
