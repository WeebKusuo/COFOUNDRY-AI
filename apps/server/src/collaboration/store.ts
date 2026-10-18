import type { Connection } from 'mongoose';
import type { MatchRequestStatus, MatchStatus } from '@cofoundry/shared';
import type { PagePosition, PageRequest } from '../briefs/store.js';
import { RecordCollection, oid, pageFilter } from '../db/record-collection.js';
import type { Tx } from '../db/transactions.js';
import type { MatchRecord, MatchRequestRecord, TrialSprintRecord } from './records.js';

/**
 * Persistence ports for collaboration (Contract Section 16). Lifetime pair uniqueness and
 * "one match per request / per pair" and "one sprint per match" are unique indexes (migration 8),
 * the final protection against concurrent writers; services add transactions on top.
 */

export type InsertResult = 'created' | 'exists' | 'duplicate';

export interface RequestListFilter {
  founderUserId?: string;
  candidateUserId?: string;
  status?: MatchRequestStatus;
  interviewId?: string;
}

export interface MatchRequestStore {
  insert(r: MatchRequestRecord, tx?: Tx): Promise<InsertResult>;
  findById(id: string, tx?: Tx): Promise<MatchRequestRecord | null>;
  findByPair(briefId: string, candidateUserId: string, tx?: Tx): Promise<MatchRequestRecord | null>;
  replace(
    next: MatchRequestRecord,
    expectedRev: number,
    tx?: Tx,
  ): Promise<MatchRequestRecord | null>;
  /** Newest first; up to limit + 1. */
  list(filter: RequestListFilter, page: PageRequest): Promise<MatchRequestRecord[]>;
  countCreatedSince(founderUserId: string, since: Date): Promise<number>;
  /** Pending requests in which `userId` is founder or candidate (optionally with `otherUserId`). */
  findPendingInvolving(
    userId: string,
    otherUserId?: string,
    tx?: Tx,
  ): Promise<MatchRequestRecord[]>;
  findPendingForBrief(briefId: string): Promise<MatchRequestRecord[]>;
  findExpiredPendingIds(now: Date, limit: number): Promise<string[]>;
  /** Requests accepted since `since` (the sweep checks each one has its match). */
  findRecentlyAcceptedIds(since: Date, limit: number): Promise<string[]>;
}

export interface MatchListFilter {
  userId: string;
  role: 'founder' | 'candidate';
  status?: MatchStatus;
}

export interface MatchStore {
  insert(m: MatchRecord, tx?: Tx): Promise<InsertResult>;
  findById(id: string, tx?: Tx): Promise<MatchRecord | null>;
  findByRequest(requestId: string, tx?: Tx): Promise<MatchRecord | null>;
  replace(next: MatchRecord, expectedRev: number, tx?: Tx): Promise<MatchRecord | null>;
  list(filter: MatchListFilter, page: PageRequest): Promise<MatchRecord[]>;
  findActiveInvolving(userId: string, otherUserId?: string, tx?: Tx): Promise<MatchRecord[]>;
  findActiveForBrief(briefId: string): Promise<MatchRecord[]>;
  /** Active matches with no sprint that started before `cutoff`. */
  findDormantIds(cutoff: Date, limit: number): Promise<string[]>;
  /** Any match (any status) between the two users — legitimate visibility for safety actions. */
  existsBetween(a: string, b: string): Promise<boolean>;
}

export interface SprintStore {
  insert(s: TrialSprintRecord, tx?: Tx): Promise<InsertResult>;
  findById(id: string, tx?: Tx): Promise<TrialSprintRecord | null>;
  findByMatch(matchId: string, tx?: Tx): Promise<TrialSprintRecord | null>;
  replace(next: TrialSprintRecord, expectedRev: number, tx?: Tx): Promise<TrialSprintRecord | null>;
  /** Non-terminal sprints whose deadline, review window or acknowledgement window passed. */
  findDueIds(now: Date, reviewCutoff: Date, ackCutoff: Date, limit: number): Promise<string[]>;
  countCompletedForFounder(founderUserId: string): Promise<number>;
}

// --- MongoDB -------------------------------------------------------------------------------------

export const COLLABORATION_COLLECTIONS = {
  requests: 'match_requests',
  matches: 'matches',
  sprints: 'trial_sprints',
} as const;

const involving = (userId: string, otherUserId?: string) =>
  otherUserId
    ? {
        $or: [
          { founderUserId: oid(userId), candidateUserId: oid(otherUserId) },
          { founderUserId: oid(otherUserId), candidateUserId: oid(userId) },
        ],
      }
    : { $or: [{ founderUserId: oid(userId) }, { candidateUserId: oid(userId) }] };

const NEWEST = { createdAt: -1, _id: -1 } as const;

export function createMongoMatchRequestStore(conn: Connection): MatchRequestStore {
  const c = new RecordCollection<MatchRequestRecord>(conn, COLLABORATION_COLLECTIONS.requests, [
    'briefId',
    'candidateUserId',
    'founderUserId',
    'interviewId',
    'matchId',
  ]);
  return {
    insert: (r, tx) => c.insert(r, tx),
    findById: (id, tx) => c.findById(id, tx),
    findByPair: (briefId, candidateUserId, tx) => c.findOne({ briefId, candidateUserId }, tx),
    replace: (next, rev, tx) => c.replace(next, rev, tx),
    list: (filter, page) =>
      c.find(
        {
          ...(filter.founderUserId ? { founderUserId: filter.founderUserId } : {}),
          ...(filter.candidateUserId ? { candidateUserId: filter.candidateUserId } : {}),
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.interviewId ? { interviewId: filter.interviewId } : {}),
          ...pageFilter(page.after),
        },
        { sort: NEWEST, limit: page.limit + 1 },
      ),
    countCreatedSince: (founderUserId, since) =>
      c.count({ founderUserId, createdAt: { $gte: since } }),
    findPendingInvolving: (userId, other, tx) =>
      c.find({ status: 'pending', ...involving(userId, other) }, { tx }),
    findPendingForBrief: (briefId) => c.find({ briefId, status: 'pending' }),
    findExpiredPendingIds: async (now, limit) =>
      (await c.find({ status: 'pending', expiresAt: { $lte: now } }, { limit })).map((r) => r.id),
    findRecentlyAcceptedIds: async (since, limit) =>
      (
        await c.find(
          { status: 'accepted', respondedAt: { $gte: since } },
          { sort: { respondedAt: -1 }, limit },
        )
      ).map((r) => r.id),
  };
}

export function createMongoMatchStore(conn: Connection): MatchStore {
  const c = new RecordCollection<MatchRecord>(conn, COLLABORATION_COLLECTIONS.matches, [
    'requestId',
    'briefId',
    'founderUserId',
    'candidateUserId',
    'interviewId',
    'sprintId',
  ]);
  return {
    insert: (m, tx) => c.insert(m, tx),
    findById: (id, tx) => c.findById(id, tx),
    findByRequest: (requestId, tx) => c.findOne({ requestId }, tx),
    replace: (next, rev, tx) => c.replace(next, rev, tx),
    list: (filter, page) =>
      c.find(
        {
          [filter.role === 'founder' ? 'founderUserId' : 'candidateUserId']: filter.userId,
          ...(filter.status ? { status: filter.status } : {}),
          ...pageFilter(page.after),
        },
        { sort: NEWEST, limit: page.limit + 1 },
      ),
    findActiveInvolving: (userId, other, tx) =>
      c.find({ status: 'active', ...involving(userId, other) }, { tx }),
    findActiveForBrief: (briefId) => c.find({ briefId, status: 'active' }),
    findDormantIds: async (cutoff, limit) =>
      (
        await c.find({ status: 'active', sprintId: null, startedAt: { $lte: cutoff } }, { limit })
      ).map((m) => m.id),
    existsBetween: async (a, b) => (await c.count(involving(a, b))) > 0,
  };
}

export function createMongoSprintStore(conn: Connection): SprintStore {
  const c = new RecordCollection<TrialSprintRecord>(conn, COLLABORATION_COLLECTIONS.sprints, [
    'matchId',
    'founderUserId',
    'candidateUserId',
    'proposerUserId',
    'contributorUserId',
    'reviewerUserId',
  ]);
  return {
    insert: (s, tx) => c.insert(s, tx),
    findById: (id, tx) => c.findById(id, tx),
    findByMatch: (matchId, tx) => c.findOne({ matchId }, tx),
    replace: (next, rev, tx) => c.replace(next, rev, tx),
    findDueIds: async (now, reviewCutoff, ackCutoff, limit) =>
      (
        await c.find(
          {
            $or: [
              {
                status: { $in: ['proposed', 'awaiting_approval', 'active'] },
                'terms.deadline': { $lte: now.toISOString() },
              },
              { status: 'submitted', submittedAt: { $lte: reviewCutoff } },
              { status: 'reviewed', reviewedAt: { $lte: ackCutoff } },
            ],
          },
          { limit },
        )
      ).map((s) => s.id),
    countCompletedForFounder: (founderUserId) => c.count({ founderUserId, status: 'completed' }),
  };
}

export type { PagePosition };
