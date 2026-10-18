import type { Connection } from 'mongoose';
import type { Logger } from '../lib/logger.js';
import { CAPABILITY_COLLECTION } from './mongo.js';

/**
 * Versioned, append-only database migrations (Section 29 deliverable: "database
 * index/migration script"). Every `up` must be idempotent so a crashed run can simply be
 * repeated. Later phases append migrations that create the collections and unique indexes of
 * Sections 14-16. Never edit or reorder an applied migration; add a new one.
 */

export interface Migration {
  version: number;
  name: string;
  up: (conn: Connection) => Promise<void>;
}

export const MIGRATIONS_COLLECTION = 'schema_migrations';

async function ensureCollection(conn: Connection, name: string): Promise<void> {
  const db = conn.db;
  if (!db) throw new Error('database not connected');
  const existing = await db.listCollections({ name }, { nameOnly: true }).toArray();
  if (existing.length === 0) await db.createCollection(name);
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'baseline',
    up: async (conn) => {
      // Collections must exist before they are written inside a transaction.
      await ensureCollection(conn, MIGRATIONS_COLLECTION);
      await ensureCollection(conn, CAPABILITY_COLLECTION);
    },
  },
  {
    version: 2,
    name: 'identity-users-sessions',
    up: async (conn) => {
      // Section 14: unique emailLower; unique tokenHash; index expiresAt. Expired and idle sessions
      // are removed by the session sweeper (AuthService.purgeExpiredSessions) — an explicit job
      // rather than a TTL index, so idle expiry (lastSeenAt) is purged by the same rule.
      await ensureCollection(conn, 'users');
      await ensureCollection(conn, 'sessions');
      const db = conn.db;
      if (!db) throw new Error('database not connected');
      const users = db.collection('users');
      await users.createIndex({ emailLower: 1 }, { unique: true, name: 'emailLower_unique' });
      await users.createIndex(
        { seedKey: 1 },
        { unique: true, sparse: true, name: 'seedKey_unique' },
      );
      const sessions = db.collection('sessions');
      await sessions.createIndex({ tokenHash: 1 }, { unique: true, name: 'tokenHash_unique' });
      await sessions.createIndex({ expiresAt: 1 }, { name: 'expiresAt' });
      await sessions.createIndex({ lastSeenAt: 1 }, { name: 'lastSeenAt' });
      await sessions.createIndex({ userId: 1 }, { name: 'userId' });
    },
  },
  {
    version: 3,
    name: 'profiles-and-consent',
    up: async (conn) => {
      // Section 14: CandidateProfile and FounderProfile are unique per user; ConsentRecord allows
      // one ACTIVE record per user/purpose/target (withdrawn records are kept as history). The
      // active rule is a unique sparse index on activeKey, which only active records carry.
      for (const name of ['candidate_profiles', 'founder_profiles', 'consent_records']) {
        await ensureCollection(conn, name);
      }
      const db = conn.db;
      if (!db) throw new Error('database not connected');
      await db
        .collection('candidate_profiles')
        .createIndex({ userId: 1 }, { unique: true, name: 'userId_unique' });
      await db
        .collection('founder_profiles')
        .createIndex({ userId: 1 }, { unique: true, name: 'userId_unique' });
      const consents = db.collection('consent_records');
      await consents.createIndex(
        { activeKey: 1 },
        { unique: true, sparse: true, name: 'active_consent_unique' },
      );
      await consents.createIndex({ userId: 1, purpose: 1 }, { name: 'userId_purpose' });
    },
  },
  {
    version: 4,
    name: 'startup-briefs-and-idempotency',
    up: async (conn) => {
      // Section 14: StartupBrief index founderUserId+status; list order indexes for the owner list
      // and candidate discovery (createdAt then _id). Section 16: IdempotencyRecord unique
      // (actorUserId, route, key), purged after 24 h by the sweeper (no TTL index, as for sessions).
      for (const name of ['startup_briefs', 'idempotency_records']) {
        await ensureCollection(conn, name);
      }
      const db = conn.db;
      if (!db) throw new Error('database not connected');
      const briefs = db.collection('startup_briefs');
      await briefs.createIndex({ founderUserId: 1, status: 1 }, { name: 'founderUserId_status' });
      await briefs.createIndex(
        { founderUserId: 1, createdAt: -1, _id: -1 },
        { name: 'founderUserId_createdAt' },
      );
      await briefs.createIndex({ status: 1, createdAt: -1, _id: -1 }, { name: 'status_createdAt' });
      await briefs.createIndex(
        { seedKey: 1 },
        { unique: true, sparse: true, name: 'seedKey_unique' },
      );
      const idem = db.collection('idempotency_records');
      await idem.createIndex(
        { actorUserId: 1, route: 1, key: 1 },
        { unique: true, name: 'actor_route_key_unique' },
      );
      await idem.createIndex({ expiresAt: 1 }, { name: 'expiresAt' });
    },
  },
  {
    version: 5,
    name: 'candidate-resumes',
    up: async (conn) => {
      // Phase 4 amendment: one resume document per candidate (metadata, extracted text and the
      // private storage key). Additive only; existing collections are untouched.
      await ensureCollection(conn, 'candidate_resumes');
      const db = conn.db;
      if (!db) throw new Error('database not connected');
      await db
        .collection('candidate_resumes')
        .createIndex({ userId: 1 }, { unique: true, name: 'userId_unique' });
    },
  },
  {
    version: 6,
    name: 'recommendation-batches',
    up: async (conn) => {
      // Section 15: RecommendationBatch index briefId+generatedAt (latest batch per brief);
      // generatedAt alone for the 24-hour entry-retention sweep.
      await ensureCollection(conn, 'recommendation_batches');
      const db = conn.db;
      if (!db) throw new Error('database not connected');
      const batches = db.collection('recommendation_batches');
      await batches.createIndex(
        { briefId: 1, generatedAt: -1, _id: -1 },
        { name: 'briefId_generatedAt' },
      );
      await batches.createIndex({ generatedAt: 1 }, { name: 'generatedAt' });
    },
  },
  {
    version: 7,
    name: 'interviews-evaluation-reports',
    up: async (conn) => {
      // Phases 7-10: one interview per brief/candidate pair (v3.0 Section 15), list indexes for
      // both participants, sweeper indexes for expiry/deadlines, one durable evaluation job per
      // session, and immutable report versions.
      for (const name of ['interview_sessions', 'evaluation_jobs', 'interview_reports']) {
        await ensureCollection(conn, name);
      }
      const db = conn.db;
      if (!db) throw new Error('database not connected');
      const sessions = db.collection('interview_sessions');
      await sessions.createIndex(
        { briefId: 1, candidateUserId: 1 },
        { unique: true, name: 'brief_candidate_unique' },
      );
      await sessions.createIndex(
        { founderUserId: 1, invitedAt: -1, _id: -1 },
        { name: 'founder_invitedAt' },
      );
      await sessions.createIndex(
        { candidateUserId: 1, invitedAt: -1, _id: -1 },
        { name: 'candidate_invitedAt' },
      );
      await sessions.createIndex({ status: 1, expiresAt: 1 }, { name: 'status_expiresAt' });
      await sessions.createIndex(
        { status: 1, globalDeadline: 1 },
        { name: 'status_globalDeadline' },
      );
      await sessions.createIndex({ invitedAt: 1 }, { name: 'invitedAt' });
      await sessions.createIndex(
        { status: 1, evaluationStatus: 1, submittedAt: 1 },
        { name: 'status_evaluation_submittedAt' },
      );
      const jobs = db.collection('evaluation_jobs');
      await jobs.createIndex({ sessionId: 1 }, { unique: true, name: 'sessionId_unique' });
      await jobs.createIndex({ status: 1, nextRunAt: 1 }, { name: 'status_nextRunAt' });
      await db
        .collection('interview_reports')
        .createIndex(
          { sessionId: 1, version: 1 },
          { unique: true, name: 'session_version_unique' },
        );
    },
  },
  {
    version: 8,
    name: 'collaboration-sprints-safety',
    up: async (conn) => {
      // Phases 11-14 (v3.0 Section 16). Collections are created up front because MongoDB cannot
      // create a collection inside a multi-document transaction on every supported version.
      const names = [
        'match_requests',
        'matches',
        'trial_sprints',
        'blocks',
        'relationship_guards',
        'safety_cases',
        'audit_events',
      ];
      for (const name of names) await ensureCollection(conn, name);
      const db = conn.db;
      if (!db) throw new Error('database not connected');
      const requests = db.collection('match_requests');
      // One request per (brief, candidate) for the lifetime of the brief.
      await requests.createIndex(
        { briefId: 1, candidateUserId: 1 },
        { unique: true, name: 'brief_candidate_unique' },
      );
      await requests.createIndex(
        { candidateUserId: 1, status: 1, createdAt: -1, _id: -1 },
        { name: 'candidate_status' },
      );
      await requests.createIndex(
        { founderUserId: 1, createdAt: -1, _id: -1 },
        { name: 'founder_createdAt' },
      );
      await requests.createIndex({ status: 1, expiresAt: 1 }, { name: 'status_expiresAt' });
      const matches = db.collection('matches');
      await matches.createIndex({ requestId: 1 }, { unique: true, name: 'requestId_unique' });
      await matches.createIndex(
        { briefId: 1, candidateUserId: 1 },
        { unique: true, name: 'brief_candidate_unique' },
      );
      await matches.createIndex(
        { founderUserId: 1, createdAt: -1, _id: -1 },
        { name: 'founder_createdAt' },
      );
      await matches.createIndex(
        { candidateUserId: 1, createdAt: -1, _id: -1 },
        { name: 'candidate_createdAt' },
      );
      await matches.createIndex({ status: 1, startedAt: 1 }, { name: 'status_startedAt' });
      const sprints = db.collection('trial_sprints');
      await sprints.createIndex({ matchId: 1 }, { unique: true, name: 'matchId_unique' });
      await sprints.createIndex({ status: 1, 'terms.deadline': 1 }, { name: 'status_deadline' });
      await sprints.createIndex({ founderUserId: 1, status: 1 }, { name: 'founder_status' });
      const blocks = db.collection('blocks');
      await blocks.createIndex(
        { blockerUserId: 1, blockedUserId: 1 },
        { unique: true, name: 'directed_pair_unique' },
      );
      await blocks.createIndex({ blockedUserId: 1 }, { name: 'blockedUserId' });
      await db
        .collection('relationship_guards')
        .createIndex({ lowUserId: 1, highUserId: 1 }, { unique: true, name: 'pair_unique' });
      const cases = db.collection('safety_cases');
      await cases.createIndex({ status: 1, createdAt: -1, _id: -1 }, { name: 'status_createdAt' });
      await cases.createIndex(
        { reporterUserId: 1, createdAt: -1, _id: -1 },
        { name: 'reporter_createdAt' },
      );
      await cases.createIndex({ targetType: 1, targetId: 1 }, { name: 'target' });
      const audit = db.collection('audit_events');
      await audit.createIndex({ time: 1 }, { name: 'time' });
      await audit.createIndex({ targetType: 1, targetId: 1, time: 1 }, { name: 'target_time' });
    },
  },
];

export const LATEST_MIGRATION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

interface MigrationRecord {
  _id: number;
  name: string;
  appliedAt: Date;
}

export interface MigrationStatus {
  current: number;
  expected: number;
  pending: number[];
  upToDate: boolean;
}

export async function getMigrationStatus(conn: Connection): Promise<MigrationStatus> {
  const db = conn.db;
  if (!db) throw new Error('database not connected');
  const applied = await db
    .collection<MigrationRecord>(MIGRATIONS_COLLECTION)
    .find({}, { projection: { _id: 1 } })
    .toArray();
  const appliedSet = new Set(applied.map((r) => r._id));
  const pending = MIGRATIONS.filter((m) => !appliedSet.has(m.version)).map((m) => m.version);
  const current = applied.reduce((max, r) => Math.max(max, r._id), 0);
  return { current, expected: LATEST_MIGRATION, pending, upToDate: pending.length === 0 };
}

export async function runMigrations(
  conn: Connection,
  logger: Logger,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<number[]> {
  const db = conn.db;
  if (!db) throw new Error('database not connected');
  const versions = migrations.map((m) => m.version);
  if (new Set(versions).size !== versions.length) throw new Error('duplicate migration version');

  const records = db.collection<MigrationRecord>(MIGRATIONS_COLLECTION);
  const appliedNow: number[] = [];
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    const done = await records.findOne({ _id: migration.version });
    if (done) continue;
    logger.info({ version: migration.version, name: migration.name }, 'applying migration');
    await migration.up(conn);
    await records.updateOne(
      { _id: migration.version },
      { $setOnInsert: { name: migration.name, appliedAt: new Date() } },
      { upsert: true },
    );
    appliedNow.push(migration.version);
  }
  return appliedNow;
}
