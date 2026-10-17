/**
 * Block relationships (Section 04: removed in either direction BEFORE aggregation). Block records
 * and the block/unblock routes belong to the Safety phase; until then no block can exist, and
 * this port is the single place matching and recommendation reads ask. The Safety phase replaces
 * NO_BLOCKS_YET with a store-backed implementation; nothing else changes.
 */
export interface BlockPolicy {
  /** Of `otherUserIds`, those with a block in either direction with `userId`. */
  blockedAmong(userId: string, otherUserIds: readonly string[]): Promise<Set<string>>;
}

export const NO_BLOCKS_YET: BlockPolicy = {
  async blockedAmong() {
    return new Set();
  },
};
