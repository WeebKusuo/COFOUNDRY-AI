import {
  ClipboardList,
  FileText,
  Handshake,
  Inbox,
  LayoutDashboard,
  MessagesSquare,
  ShieldCheck,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { UserRole } from '@cofoundry/shared';

/**
 * Navigation per role, mapped to the required screens of Contract Section 02. Each destination
 * describes what it will hold so preview pages state plainly what is not built yet.
 */
export interface NavItem {
  /** Path relative to the workspace root; '' is the overview. */
  path: string;
  label: string;
  icon: LucideIcon;
  /** One sentence describing the screen's purpose (Section 02). */
  purpose: string;
}

export interface WorkspaceDefinition {
  role: UserRole;
  basePath: string;
  title: string;
  summary: string;
  nav: NavItem[];
}

export const WORKSPACES: Record<UserRole, WorkspaceDefinition> = {
  founder: {
    role: 'founder',
    basePath: '/founder',
    title: 'Founder workspace',
    summary:
      'Write a backend contributor brief, review matched candidates, read interview reports and agree a bounded trial sprint.',
    nav: [
      {
        path: '',
        label: 'Overview',
        icon: LayoutDashboard,
        purpose: 'Your profile, owned briefs and what needs your attention.',
      },
      {
        path: 'profile',
        label: 'Profile',
        icon: UserRound,
        purpose: 'Your bio and company link, shown to candidates next to your briefs.',
      },
      {
        path: 'briefs',
        label: 'Briefs',
        icon: FileText,
        purpose: 'Create a draft brief, publish it with fixed terms, or close it.',
      },
      {
        path: 'candidates',
        label: 'Candidates',
        icon: Users,
        purpose:
          'Recommended, provisional and near-match candidates with every score factor shown.',
      },
      {
        path: 'interviews',
        label: 'Interviews',
        icon: ClipboardList,
        purpose: 'Invitations you sent and the reports from submitted interviews.',
      },
      {
        path: 'requests',
        label: 'Requests',
        icon: MessagesSquare,
        purpose: 'Collaboration requests you sent and their status.',
      },
      {
        path: 'matches',
        label: 'Matches',
        icon: Handshake,
        purpose: 'Agreed terms, the trial sprint, submission and review.',
      },
      {
        path: 'account',
        label: 'Safety & account',
        icon: ShieldCheck,
        purpose: 'People you blocked, and your reports and correction requests.',
      },
    ],
  },
  candidate: {
    role: 'candidate',
    basePath: '/candidate',
    title: 'Candidate workspace',
    summary:
      'Keep your profile current, see terms before you consent, answer interviews and decide on requests and sprints.',
    nav: [
      {
        path: '',
        label: 'Overview',
        icon: LayoutDashboard,
        purpose: 'Your discovery status and anything waiting for your decision.',
      },
      {
        path: 'profile',
        label: 'Profile',
        icon: UserRound,
        purpose: 'Skills, projects, availability, interests and the discovery switch.',
      },
      {
        path: 'inbox',
        label: 'Inbox',
        icon: Inbox,
        purpose: 'Interview invitations and collaboration requests, each with expiry and status.',
      },
      {
        path: 'matches',
        label: 'Matches',
        icon: Handshake,
        purpose: 'Shared terms, sprint approvals, your submission and the founder’s review.',
      },
      {
        path: 'account',
        label: 'Safety & account',
        icon: ShieldCheck,
        purpose: 'People you blocked, and your reports and correction requests.',
      },
    ],
  },
  moderator: {
    role: 'moderator',
    basePath: '/moderator',
    title: 'Moderator workspace',
    summary:
      'Claim and resolve safety reports and correction requests. Access is limited to assigned cases.',
    nav: [
      {
        path: '',
        label: 'Overview',
        icon: LayoutDashboard,
        purpose: 'Open and in-review case counts.',
      },
      {
        path: 'cases',
        label: 'Case queue',
        icon: ShieldCheck,
        purpose: 'Claim a case, view its minimum evidence and record a resolution.',
      },
    ],
  },
};

export function workspaceHref(def: WorkspaceDefinition, item: NavItem): string {
  return item.path ? `${def.basePath}/${item.path}` : def.basePath;
}
