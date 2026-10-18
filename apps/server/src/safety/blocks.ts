import type { BlockStore } from './store.js';

/**
 * Block relationships (Section 04: removed in either direction BEFORE aggregation). Matching,
 * recommendation reads, invitations, interviews, requests, matches and sprints ask this port
 * at every sensitive boundary. Phase 14 backs it with the Block collection.
 */
export interface BlockPolicy {
  /** Of `otherUserIds`, those with a block in either direction with `userId`. */
  blockedAmong(userId: string, otherUserIds: readonly string[]): Promise<Set<string>>;
  /** A block in either direction between the two users. */
  isBlocked?(a: string, b: string): Promise<boolean>;
}

/** No blocks at all (unit tests that do not exercise safety). */
export const NO_BLOCKS_YET: BlockPolicy = {
  async blockedAmong() {
    return new Set();
  },
  async isBlocked() {
    return false;
  },
};

export function blockPolicyFromStore(store: BlockStore): BlockPolicy {
  return {
    blockedAmong: (userId, others) => store.blockedAmong(userId, others),
    isBlocked: (a, b) => store.existsEither(a, b),
  };
}

export async function isPairBlocked(policy: BlockPolicy, a: string, b: string): Promise<boolean> {
  if (policy.isBlocked) return policy.isBlocked(a, b);
  return (await policy.blockedAmong(a, [b])).has(b);
}
