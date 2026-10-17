import { createInterface } from 'node:readline/promises';
import { ConfigError, loadConfig } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { DEMO_ACCOUNTS, DEV_DEFAULT_DEMO_PASSWORD } from './demo-accounts.js';
import { closeMongo, connectMongo } from './mongo.js';
import { SeedRefusedError, seedDemoAccounts } from './seed.js';

/**
 * `npm run db:seed` — creates or updates the shared demo accounts.
 * `npm run db:seed -- --reset` — removes demo accounts first; asks for confirmation
 * (or pass --yes for non-interactive use). Never touches pilot accounts.
 */
async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger(config.logLevel === 'silent' ? 'info' : config.logLevel, {
    component: 'seed',
  });

  const password =
    process.env.SEED_DEMO_PASSWORD?.trim() ||
    (config.isProduction ? '' : DEV_DEFAULT_DEMO_PASSWORD);
  if (!password) throw new SeedRefusedError('Set SEED_DEMO_PASSWORD to seed in production.');

  const reset = args.has('--reset');
  if (reset && !args.has('--yes')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Delete and recreate ALL demo accounts? Type "reset": ');
    rl.close();
    if (answer.trim() !== 'reset') throw new SeedRefusedError('Reset cancelled.');
  }

  const conn = await connectMongo(config.mongodbUri, logger, { appName: 'cofoundry-seed' });
  try {
    const summary = await seedDemoAccounts(conn, logger, {
      demoMode: config.demoMode,
      password,
      reset,
    });
    logger.info(
      {
        created: summary.created.length,
        updated: summary.updated.length,
        unchanged: summary.unchanged.length,
        removed: summary.removed,
        profilesCreated: summary.profilesCreated,
      },
      'demo accounts seeded',
    );
    process.stdout.write(
      `Demo accounts (password from SEED_DEMO_PASSWORD${
        process.env.SEED_DEMO_PASSWORD ? '' : ', development default'
      }):\n${DEMO_ACCOUNTS.map((a) => `  ${a.roles.join('+').padEnd(10)} ${a.email}`).join('\n')}\n`,
    );
  } finally {
    await closeMongo(conn);
  }
}

main().catch((err: unknown) => {
  const known = err instanceof ConfigError || err instanceof SeedRefusedError;
  process.stderr.write(
    `${known ? '' : 'Seed failed: '}${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
