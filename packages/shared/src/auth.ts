import type { UserRole } from './constants.js';

/**
 * Identity contracts (Sections 14, 18, 22). Accounts are provisioned by the seed command or the
 * operator only: there is no signup, email verification or password reset in v3.0.
 */

export const ACCOUNT_STATUSES = ['active', 'suspended', 'deletion_pending', 'deleted'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACCOUNT_MODES = ['demo', 'pilot'] as const;
export type AccountMode = (typeof ACCOUNT_MODES)[number];

/** Section 22: provisioned passwords are 12-128 characters. */
export const PASSWORD_LIMITS = { min: 12, max: 128 } as const;

export const CSRF_HEADER = 'X-CSRF-Token' as const;

/** The signed-in user's own identity. Never includes hashes, sessions or other users. */
export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  roles: UserRole[];
  accountMode: AccountMode;
  /** Always null for seeded demo accounts — they are labelled "demo account", never verified. */
  emailVerifiedAt: string | null;
}

/** GET /auth/csrf */
export interface CsrfData {
  csrfToken: string;
}

/** POST /auth/login request body. */
export interface LoginRequest {
  email: string;
  password: string;
}

/** POST /auth/login response data. The client must call GET /auth/csrf again afterwards. */
export interface LoginData {
  user: SessionUser;
}

/**
 * GET /me. Profile summaries are filled once profiles exist (Phase 3); until then the list is
 * empty rather than invented.
 */
export interface MeData {
  user: SessionUser;
  profileSummaries: Array<{ role: UserRole; revision: number; complete: boolean }>;
}

/** Normalised account key used for lookup and per-account rate limiting. */
export function normalizeEmail(email: string): string {
  return email.normalize('NFKC').trim().toLowerCase();
}
