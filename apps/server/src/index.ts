import http from 'node:http';
import type { Connection } from 'mongoose';
import { ConfigError, describeConfig, loadConfig } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { createApp } from './http/app.js';
import { createInternalApp } from './http/internal.js';
import { checkTransactionSupport, closeMongo, connectMongo } from './db/mongo.js';
import { getMigrationStatus } from './db/migrations.js';
import { AiConfigError, createAiRegistry } from './ai/index.js';
import { AuthService } from './auth/service.js';
import { createMongoIdentityStore } from './auth/store.js';

/**
 * Process entry point. Fails fast (exit 1) when configuration is invalid, MongoDB is unreachable,
 * or — in production — transactions cannot run or migrations are pending (Section 22).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  logger.info(describeConfig(config), 'starting cofoundry server');

  // Resolve AI adapters up front so an unknown provider label fails startup, not a later request.
  const ai = createAiRegistry(config.llm);
  logger.info(
    { providers: ai.describe().map((d) => `${d.capability}=${d.providerId}`) },
    'ai providers resolved',
  );

  let conn: Connection | null = await connectMongo(config.mongodbUri, logger);
  logger.info('mongodb connected');

  const tx = await checkTransactionSupport(conn);
  if (!tx.supported) {
    if (config.isProduction) {
      throw new Error('MongoDB transactions are unavailable; a replica set is required.');
    }
    logger.warn(
      'MongoDB transactions are unavailable. Run MongoDB as a replica set; ' +
        'production startup refuses to run without transactions.',
    );
  }

  const migrations = await getMigrationStatus(conn);
  if (!migrations.upToDate) {
    if (config.isProduction) {
      throw new Error(`Pending migrations ${migrations.pending.join(', ')}; run db:migrate first.`);
    }
    logger.warn({ pending: migrations.pending }, 'pending migrations; run `npm run db:migrate`');
  }

  const auth = new AuthService(createMongoIdentityStore(conn), {
    sessionTtlSeconds: config.sessionTtlSeconds,
  });
  const app = createApp({ config, logger, auth });

  // Session sweeper: removes expired and idle sessions every 5 minutes (validity is still
  // checked on every request, so the sweep only keeps the collection small).
  const sweep = setInterval(() => {
    auth
      .purgeExpiredSessions()
      .then((removed) => removed > 0 && logger.info({ removed }, 'expired sessions purged'))
      .catch((err: unknown) => logger.warn({ err }, 'session sweep failed'));
  }, 5 * 60_000);
  sweep.unref();
  const server = http.createServer(app);
  // Bound slow clients; keep-alive shorter than typical proxy idle timeouts is set by the proxy.
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  logger.info({ port: config.port }, 'http server listening');

  let internal: http.Server | null = null;
  if (config.internalPort > 0) {
    internal = http.createServer(createInternalApp(() => conn));
    await new Promise<void>((resolve) =>
      internal!.listen(config.internalPort, '127.0.0.1', resolve),
    );
    logger.info({ port: config.internalPort }, 'internal readiness probe on 127.0.0.1');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const close = (s: http.Server | null) =>
      new Promise<void>((resolve) => (s ? s.close(() => resolve()) : resolve()));
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    clearInterval(sweep);
    const serversClosed = Promise.all([close(server), close(internal)]);
    server.closeIdleConnections();
    await serversClosed;
    if (conn) await closeMongo(conn);
    conn = null;
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError || err instanceof AiConfigError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`Startup failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(1);
});
