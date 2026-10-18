/**
 * E2E server: a real CoFoundry server process on http://localhost:5180 serving the built SPA and
 * the API from one origin, backed by a real MongoDB (in-memory replica set by default, or
 * E2E_MONGODB_URI), migrated and seeded with the demo accounts. Started by Playwright's webServer.
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../apps/server/src/config/env.js';
import { createLogger } from '../apps/server/src/lib/logger.js';
import { connectMongo } from '../apps/server/src/db/mongo.js';
import { runMigrations } from '../apps/server/src/db/migrations.js';
import { seedDemoAccounts } from '../apps/server/src/db/seed.js';
import { AuthService } from '../apps/server/src/auth/service.js';
import { createMongoIdentityStore } from '../apps/server/src/auth/store.js';
import { ProfileService } from '../apps/server/src/profiles/service.js';
import { createMongoProfileStore } from '../apps/server/src/profiles/store.js';
import { createApp } from '../apps/server/src/http/app.js';
import { createRateLimiter } from '../apps/server/src/http/middleware/rate-limit.js';
import { BriefService } from '../apps/server/src/briefs/service.js';
import {
  createMongoBriefStore,
  createMongoIdempotencyStore,
} from '../apps/server/src/briefs/store.js';
import { ResumeService } from '../apps/server/src/resumes/service.js';
import { createPdfTextExtractor } from '../apps/server/src/resumes/extract.js';
import { createLocalFileStorage } from '../apps/server/src/resumes/storage.js';
import { createMongoResumeStore } from '../apps/server/src/resumes/store.js';
import { RecommendationService } from '../apps/server/src/recommendations/service.js';
import { createMongoRecommendationStore } from '../apps/server/src/recommendations/store.js';
import { createAiRegistry } from '../apps/server/src/ai/index.js';
import { createSpeechServices } from '../apps/server/src/speech/services.js';
import { createCodeJudge } from '../apps/server/src/coding/index.js';
import { InterviewService } from '../apps/server/src/interviews/service.js';
import { EvaluationWorker } from '../apps/server/src/interviews/evaluation.js';
import {
  createMongoEvaluationJobStore,
  createMongoInterviewStore,
  createMongoReportStore,
} from '../apps/server/src/interviews/store.js';
import { createMongoAuditStore } from '../apps/server/src/audit/audit.js';
import {
  createMongoMatchRequestStore,
  createMongoMatchStore,
  createMongoSprintStore,
} from '../apps/server/src/collaboration/store.js';
import { checkTransactionSupport } from '../apps/server/src/db/mongo.js';
import { createMongoTransactionRunner } from '../apps/server/src/db/transactions.js';
import { blockPolicyFromStore } from '../apps/server/src/safety/blocks.js';
import {
  createMongoBlockStore,
  createMongoRelationshipGuardStore,
  createMongoSafetyCaseStore,
} from '../apps/server/src/safety/store.js';
import { buildCollaborationAndSafety } from '../apps/server/src/safety/wiring.js';
import { E2E_PASSWORD, E2E_PORT, STATE_FILE } from './shared.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  let uri = process.env.E2E_MONGODB_URI;
  if (!uri) {
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    uri = replSet.getUri('cofoundry-e2e');
    process.on('exit', () => void replSet.stop());
  }

  const webDistDir = path.resolve(here, '../apps/web/dist');
  if (!fs.existsSync(path.join(webDistDir, 'index.html'))) {
    throw new Error('apps/web/dist is missing; run `npm run build` first.');
  }

  // Real local-disk resume storage in a fresh temporary directory.
  const resumeDir = path.join(os.tmpdir(), 'cofoundry-e2e-resumes');
  fs.rmSync(resumeDir, { recursive: true, force: true });

  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: String(E2E_PORT),
    INTERNAL_PORT: '0',
    APP_ORIGIN: `http://localhost:${E2E_PORT}`,
    MONGODB_URI: uri,
    DEMO_MODE: 'true',
    SERVE_WEB: 'true',
    WEB_DIST_DIR: webDistDir,
    RESUME_STORAGE_DIR: resumeDir,
    LOG_LEVEL: 'warn',
    // Deterministic TEST DOUBLES for the AI interviewer/evaluator, speech service and code
    // sandbox (refused in production). Real Groq, faster-whisper/Piper and Judge0 are not
    // reachable from the E2E environment; reports produced here are labelled as mock output.
    LLM_PROVIDER: 'mock',
    SPEECH_PROVIDER: 'mock',
    CODE_EXECUTION_PROVIDER: 'mock',
  });
  const logger = createLogger(config.logLevel, { component: 'e2e' });
  const conn = await connectMongo(config.mongodbUri, logger);
  await conn.db?.dropDatabase();
  await runMigrations(conn, logger);
  await seedDemoAccounts(conn, logger, { demoMode: true, password: E2E_PASSWORD });

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
    logger,
  );
  const ai = createAiRegistry({
    provider: config.llm.provider,
    interviewerModel: null,
    evaluatorModel: null,
    apiKey: null,
    baseUrl: null,
  });
  const interviewStore = createMongoInterviewStore(conn);
  const jobs = createMongoEvaluationJobStore(conn);
  const reports = createMongoReportStore(conn);
  const judge = createCodeJudge(config.codeExecution);
  const aiCall = { timeoutMs: config.llm.timeoutMs, maxAttempts: config.llm.maxAttempts };
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
    speech: createSpeechServices(config.speech),
    judge,
    logger,
  });
  new EvaluationWorker({
    jobs,
    store: interviewStore,
    reports,
    interviews,
    identity,
    ai,
    aiCall,
    judge,
    logger,
  }).start(500);
  const deadlines = setInterval(() => void interviews.sweep().catch(() => undefined), 2_000);
  deadlines.unref();
  // FerretDB (the usual E2E_MONGODB_URI here) has no transactions; the in-memory replica set does.
  const atomic = (await checkTransactionSupport(conn)).supported;
  const phase11 = buildCollaborationAndSafety(
    {
      requests: createMongoMatchRequestStore(conn),
      matches: createMongoMatchStore(conn),
      sprints: createMongoSprintStore(conn),
      blocks: blockStore,
      guards: createMongoRelationshipGuardStore(conn),
      cases: createMongoSafetyCaseStore(conn),
      audit: createMongoAuditStore(conn),
      tx: createMongoTransactionRunner(conn, { atomic, logger }),
    },
    {
      identity,
      briefStore,
      briefs,
      profiles: profileStore,
      profileService: profiles,
      interviews,
      recommendations,
      logger,
    },
  );
  const collabSweep = setInterval(() => {
    void phase11.collaboration.sweep().catch(() => undefined);
    void phase11.sprints.sweep().catch(() => undefined);
  }, 2_000);
  collabSweep.unref();
  const server = http.createServer(
    createApp({
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
      // The suite signs in dozens of times per minute from one IP. Only the CSRF bootstrap limit
      // is raised here; its real 30/min value is covered by apps/server/test/rate-limits.test.ts,
      // and every other limit (login, general, uploads) keeps its production value.
      rateLimiters: { csrf: createRateLimiter({ windowMs: 60_000, limit: 600 }) },
    }),
  );
  await new Promise<void>((resolve) => server.listen(E2E_PORT, resolve));
  fs.writeFileSync(STATE_FILE, JSON.stringify({ mongodbUri: uri }));
  process.stdout.write(`e2e server ready on http://localhost:${E2E_PORT}\n`);

  const stop = () => {
    server.close();
    void conn.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err: unknown) => {
  process.stderr.write(`e2e server failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
