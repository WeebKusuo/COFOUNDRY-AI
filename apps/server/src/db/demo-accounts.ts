import type { UserRole } from '@cofoundry/shared';

/**
 * Seeded demo identities (Section 26). These are shared demo accounts for the controlled demo,
 * labelled "demo account" in the UI and never reused for real users. Candidate names follow the
 * PayPilot matching fixture; their profiles are seeded when profiles exist (Phase 3).
 */
export interface DemoAccount {
  seedKey: string;
  email: string;
  displayName: string;
  roles: UserRole[];
}

export const DEMO_COHORT_ID = 'demo-v3.0';
export const DEMO_EMAIL_DOMAIN = 'demo.cofoundry.test';

const at = (local: string) => `${local}@${DEMO_EMAIL_DOMAIN}`;

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    seedKey: 'demo:founder:paypilot',
    email: at('founder'),
    displayName: 'Rohan (PayPilot)',
    roles: ['founder'],
  },
  { seedKey: 'demo:candidate:asha', email: at('asha'), displayName: 'Asha', roles: ['candidate'] },
  { seedKey: 'demo:candidate:dev', email: at('dev'), displayName: 'Dev', roles: ['candidate'] },
  { seedKey: 'demo:candidate:isha', email: at('isha'), displayName: 'Isha', roles: ['candidate'] },
  {
    seedKey: 'demo:candidate:kabir',
    email: at('kabir'),
    displayName: 'Kabir',
    roles: ['candidate'],
  },
  { seedKey: 'demo:candidate:mira', email: at('mira'), displayName: 'Mira', roles: ['candidate'] },
  { seedKey: 'demo:candidate:nila', email: at('nila'), displayName: 'Nila', roles: ['candidate'] },
  {
    seedKey: 'demo:candidate:hidden',
    email: at('hidden'),
    displayName: 'Hidden candidate',
    roles: ['candidate'],
  },
  {
    seedKey: 'demo:moderator',
    email: at('moderator'),
    displayName: 'Demo moderator',
    roles: ['moderator'],
  },
];

/** Development-only default; production seeding requires SEED_DEMO_PASSWORD explicitly. */
export const DEV_DEFAULT_DEMO_PASSWORD = 'cofoundry-demo-2026';
