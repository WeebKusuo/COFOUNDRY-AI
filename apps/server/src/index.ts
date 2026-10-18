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
import { ProfileService } from './profiles/service.js';
import { createMongoProfileStore } from './profiles/store.js';
import { BriefService } from './briefs/service.js';
import { createMongoBriefStore, createMongoIdempotencyStore } from './briefs/store.js';
import { createPdfTextExtractor } from './resumes/extract.js';
import { ResumeService } from './resumes/service.js';
import { createLocalFileStorage } from './resumes/storage.js';
import { createMongoResumeStore } from './resumes/store.js';
import { RecommendationService } from './recommendations/service.js';
import { createMongoRecommendationStore } from './recommendations/store.js';
import { createSpeechServices } from './speech/services.js';
import { createCodeJudge } from './coding/index.js';
import { InterviewService } from './interviews/service.js';
import { EvaluationWorker } from './interviews/evaluation.js';
import {
  createMongoEvaluationJobStore,
  createMongoInterviewStore,
  createMongoReportStore,
} from './interviews/store.js';
import { createMongoAuditStore } from './audit/audit.js';
import {
  createMongoMatchRequestStore,
  createMongoMatchStore,
  createMongoSprintStore,
} from './collaboration/store.js';
import { createMongoTransactionRunner } from './db/transactions.js';
import { blockPolicyFromStore } from './safety/blocks.js';
import {
  createMongoBlockStore,
  createMongoRelationshipGuardStore,
  createMongoSafetyCaseStore,
} from './safety/store.js';
import { buildCollaborationAndSafety } from './safety/wiring.js';

/**
 * Process entry point. Fails fast (exit 1) when configuration is invalid, MongoDB is unreachable,
 * or — in production — transactions cannot run or migrations are pending (Section 22).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  logger.info(describeConfig(config), 'starting cofoundry server');

  // Resolve AI adapters up front so an unknown provider label fails startup, not a later request.
  const ai = createAiRegistry({
    provider: config.llm.provider,
    interviewerModel: config.llm.interviewerModel,
    evaluatorModel: config.llm.evaluatorModel,
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
    allowInsecureHttp: !config.isProduction,
  });
  const speech = createSpeechServices(config.speech);
  const judge = createCodeJudge(config.codeExecution);
  if (!judge.available) {
    logger.warn('code execution is DISABLED: no secure sandbox (Judge0) configured');
  }
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

  const identity = createMongoIdentityStore(conn);
  const auth = new AuthService(identity, { sessionTtlSeconds: config.sessionTtlSeconds });
  const profileStore = createMongoProfileStore(conn);
  const profiles = new ProfileService(profileStore, identity);
  const briefStore = createMongoBriefStore(conn);
  const briefs = new BriefService(briefStore, identity, profileStore);
  const blockStore = createMongoBlockStore(conn);
  const recommendations = new RecommendationService(
    createMongoRecommendationStore(conn),
    briefStore,
    identity,
    profileStore,
    blockPolicyFromStore(blockStore),
  );
  const idempotency = createMongoIdempotencyStore(conn);
  const resumes = new ResumeService(
    createMongoResumeStore(conn),
    createLocalFileStorage(config.resumeStorageDir),
    profileStore,
    createPdfTextExtractor(),
    logger.child({ component: 'resumes' }),
  );
  const interviewStore = createMongoInterviewStore(conn);
  const jobs = createMongoEvaluationJobStore(conn);
  const reports = createMongoReportStore(conn);
  const aiCall = { timeoutMs: config.llm.timeoutMs, maxAttempts: config.llm.maxAttempts };
  const interviewLogger = logger.child({ component: 'interviews' });
  const interviews = new InterviewService({
    store: interviewStore,
    jobs,
    reports,
    briefStore,
    briefs,
    identity,
    profiles: profileStore,
    recommendations,
    resumes,
    ai,
    aiCall,
    speech,
    judge,
    logger: interviewLogger,
  });
  const worker = new EvaluationWorker({
    jobs,
    store: interviewStore,
    reports,
    interviews,
    identity,
    ai,
    aiCall,
    judge,
    logger: interviewLogger,
  });
  worker.start();
  if (!tx.supported) {
    logger.warn(
      'collaboration writes run WITHOUT multi-document transactions (development only); ' +
        'unique indexes still prevent duplicates, but a crash between two writes is not rolled back',
    );
  }
  const phase11 = buildCollaborationAndSafety(
    {
      requests: createMongoMatchRequestStore(conn),
      matches: createMongoMatchStore(conn),
      sprints: createMongoSprintStore(conn),
      blocks: blockStore,
      guards: createMongoRelationshipGuardStore(conn),
      cases: createMongoSafetyCaseStore(conn),
      audit: createMongoAuditStore(conn),
      tx: createMongoTransactionRunner(conn, { atomic: tx.supported, logger }),
    },
    {
      identity,
      briefStore,
      briefs,
      profiles: profileStore,
      profileService: profiles,
      interviews,
      recommendations,
      logger: logger.child({ component: 'collaboration' }),
    },
  );
  const app = createApp({
    config,
    logger,
    auth,
    profiles,
    briefs,
    idempotency,
    resumes,
    recommendations,
    interviews,
    collaboration: { requests: phase11.collaboration, sprints: phase11.sprints },
    safety: phase11.safety,
  });
  // Request/sprint expiry, review/acknowledgement windows and dormant matches every 60 seconds
  // (contract Section 25); handlers also enforce them synchronously.
  const collaborationSweep = setInterval(() => {
    phase11.collaboration
      .sweep()
      .then((r) => (r.expired || r.repaired || r.dormant) && logger.info(r, 'collaboration sweep'))
      .catch((err: unknown) => logger.warn({ err }, 'collaboration sweep failed'));
    phase11.sprints
      .sweep()
      .then((n) => n > 0 && logger.info({ cancelled: n }, 'sprint deadlines applied'))
      .catch((err: unknown) => logger.warn({ err }, 'sprint sweep failed'));
  }, 60_000);
  collaborationSweep.unref();
  // Interview deadlines and leases every 15 seconds (contract Section 25 job table).
  const deadlines = setInterval(() => {
    interviews
      .sweep()
      .catch((err: unknown) => logger.warn({ err }, 'interview deadline sweep failed'));
  }, 15_000);
  deadlines.unref();

  // Sweeper every 5 minutes: expired/idle sessions, idempotency records older than 24 h and
  // recommendation entries older than 24 h
  // (validity is checked on every request, so the sweep only keeps collections small).
  const sweep = setInterval(() => {
    auth
      .purgeExpiredSessions()
      .then((removed) => removed > 0 && logger.info({ removed }, 'expired sessions purged'))
      .catch((err: unknown) => logger.warn({ err }, 'session sweep failed'));
    recommendations
      .purgeExpiredEntries()
      .then((purged) => purged > 0 && logger.info({ purged }, 'recommendation entries purged'))
      .catch((err: unknown) => logger.warn({ err }, 'recommendation retention sweep failed'));
    interviews
      .purgeRetention()
      .then(
        (r) => (r.minimized > 0 || r.deleted > 0) && logger.info(r, 'interview retention applied'),
      )
      .catch((err: unknown) => logger.warn({ err }, 'interview retention sweep failed'));
    idempotency
      .purgeExpired(new Date())
      .then((removed) => removed > 0 && logger.info({ removed }, 'idempotency records purged'))
      .catch((err: unknown) => logger.warn({ err }, 'idempotency sweep failed'));
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
    clearInterval(deadlines);
    clearInterval(collaborationSweep);
    worker.stop();
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
