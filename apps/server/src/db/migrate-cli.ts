import { loadConfig, ConfigError } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { closeMongo, connectMongo } from './mongo.js';
import { getMigrationStatus, runMigrations } from './migrations.js';

/** `npm run db:migrate` — applies pending migrations and prints the resulting version. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel === 'silent' ? 'info' : config.logLevel, {
    component: 'migrate',
  });
  const conn = await connectMongo(config.mongodbUri, logger, { appName: 'cofoundry-migrate' });
  try {
    const applied = await runMigrations(conn, logger);
    const status = await getMigrationStatus(conn);
    logger.info({ applied, current: status.current, expected: status.expected }, 'migrations done');
  } finally {
    await closeMongo(conn);
  }
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`Migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(1);
});
