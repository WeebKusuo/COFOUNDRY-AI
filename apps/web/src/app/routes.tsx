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
import { CandidateProfilePage } from '../features/profile/CandidateProfilePage';
import { FounderProfilePage } from '../features/profile/FounderProfilePage';
import { BriefsListPage } from '../features/briefs/BriefsListPage';
import { BriefEditorPage } from '../features/briefs/BriefEditorPage';
import { RecommendationsPage } from '../features/recommendations/RecommendationsPage';
import type { ReactElement } from 'react';
import type { UserRole } from '@cofoundry/shared';

/** Screens built so far; every other nav destination renders the "not available yet" state. */
const SCREENS: Partial<Record<UserRole, Record<string, ReactElement>>> = {
  candidate: { profile: <CandidateProfilePage /> },
  founder: {
    profile: <FounderProfilePage />,
    briefs: <BriefsListPage />,
    candidates: <RecommendationsPage />,
  },
};

/** Detail routes below a nav destination (not nav items themselves). */
const DETAIL_ROUTES: Partial<Record<UserRole, RouteObject[]>> = {
  founder: [{ path: 'briefs/:briefId', element: <BriefEditorPage /> }],
};

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
    children: [
      ...WORKSPACES[role].nav.map((item): RouteObject =>
        item.path === ''
          ? { index: true, element: <WorkspaceHome role={role} /> }
          : {
              path: item.path,
              element: SCREENS[role]?.[item.path] ?? <PlannedScreen role={role} item={item} />,
            },
      ),
      ...(DETAIL_ROUTES[role] ?? []),
    ],
  })),
  {
    element: <PublicLayout />,
    children: [{ path: '*', element: <NotFoundPage /> }],
  },
];
