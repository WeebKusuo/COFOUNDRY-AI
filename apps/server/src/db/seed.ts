import type { Connection } from 'mongoose';
import { assertPasswordPolicy, hashPassword, verifyPassword } from '../auth/crypto.js';
import { identityModels } from '../auth/models.js';
import type { Logger } from '../lib/logger.js';
import { DEMO_ACCOUNTS, DEMO_COHORT_ID, type DemoAccount } from './demo-accounts.js';
import { getMigrationStatus } from './migrations.js';

export class SeedRefusedError extends Error {}

export interface SeedOptions {
  demoMode: boolean;
  password: string;
  /** Delete all demo accounts (and their sessions) first. Requires explicit confirmation. */
  reset?: boolean;
  accounts?: readonly DemoAccount[];
}

export interface SeedSummary {
  created: string[];
  updated: string[];
  unchanged: string[];
  removed: number;
}

/**
 * Idempotent demo seeding by seedKey (Section 26). Refuses outside DEMO_MODE and refuses any
 * database that holds pilot accounts. Re-running produces the same state; a changed demo password
 * re-hashes and bumps authVersion so old sessions stop working.
 */
export async function seedDemoAccounts(
  conn: Connection,
  logger: Logger,
  options: SeedOptions,
): Promise<SeedSummary> {
  if (!options.demoMode) {
    throw new SeedRefusedError('Seeding is only allowed with DEMO_MODE=true.');
  }
  assertPasswordPolicy(options.password);
  const migrations = await getMigrationStatus(conn);
  if (!migrations.upToDate) {
    throw new SeedRefusedError(`Run migrations first (pending: ${migrations.pending.join(', ')}).`);
  }

  const { User, Session } = identityModels(conn);
  if (await User.exists({ accountMode: 'pilot' })) {
    throw new SeedRefusedError('This database contains pilot accounts; demo seeding is refused.');
  }

  const summary: SeedSummary = { created: [], updated: [], unchanged: [], removed: 0 };

  if (options.reset) {
    const demoUsers = await User.find({ accountMode: 'demo' }, { _id: 1 }).lean().exec();
    const ids = demoUsers.map((u) => u._id);
    await Session.deleteMany({ userId: { $in: ids } }).exec();
    const res = await User.deleteMany({ _id: { $in: ids } }).exec();
    summary.removed = res.deletedCount;
    logger.info({ removed: summary.removed }, 'demo accounts removed');
  }

  for (const account of options.accounts ?? DEMO_ACCOUNTS) {
    const emailLower = account.email.toLowerCase();
    const existing = await User.findOne({ seedKey: account.seedKey }).exec();
    if (!existing) {
      await User.create({
        seedKey: account.seedKey,
        emailLower,
        passwordHash: await hashPassword(options.password),
        displayName: account.displayName,
        roles: account.roles,
        cohortId: DEMO_COHORT_ID,
        status: 'active',
        accountMode: 'demo',
        authVersion: 1,
        emailVerifiedAt: null,
      });
      summary.created.push(emailLower);
      continue;
    }

    let changed = false;
    const set = (key: 'emailLower' | 'displayName' | 'cohortId', value: string) => {
      if (existing.get(key) !== value) {
        existing.set(key, value);
        changed = true;
      }
    };
    set('emailLower', emailLower);
    set('displayName', account.displayName);
    set('cohortId', DEMO_COHORT_ID);
    if ([...existing.roles].sort().join() !== [...account.roles].sort().join()) {
      existing.roles = [...account.roles];
      existing.authVersion += 1;
      changed = true;
    }
    if (existing.status !== 'active' || existing.accountMode !== 'demo') {
      existing.status = 'active';
      existing.accountMode = 'demo';
      changed = true;
    }
    if (existing.emailVerifiedAt !== null) {
      existing.emailVerifiedAt = null;
      changed = true;
    }
    if (!(await verifyPassword(existing.passwordHash, options.password))) {
      existing.passwordHash = await hashPassword(options.password);
      existing.authVersion += 1;
      changed = true;
    }
    if (changed) {
      await existing.save();
      summary.updated.push(emailLower);
    } else {
      summary.unchanged.push(emailLower);
    }
  }
  return summary;
}
