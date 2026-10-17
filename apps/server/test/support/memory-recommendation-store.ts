import type {
  RecommendationBatchRecord,
  RecommendationStore,
} from '../../src/recommendations/store.js';

/** In-memory RecommendationStore with the same ordering and idempotent insert as Mongo. */
export class MemoryRecommendationStore implements RecommendationStore {
  batches = new Map<string, RecommendationBatchRecord>();

  async insert(batch: RecommendationBatchRecord) {
    const existing = this.batches.get(batch.id);
    if (existing) return structuredClone(existing);
    this.batches.set(batch.id, structuredClone(batch));
    return structuredClone(batch);
  }
  async findById(id: string) {
    const b = this.batches.get(id);
    return b ? structuredClone(b) : null;
  }
  async findLatestForBrief(briefId: string) {
    const list = [...this.batches.values()]
      .filter((b) => b.briefId === briefId)
      .sort((a, b) =>
        b.generatedAt.getTime() !== a.generatedAt.getTime()
          ? b.generatedAt.getTime() - a.generatedAt.getTime()
          : b.id < a.id
            ? -1
            : 1,
      );
    return list[0] ? structuredClone(list[0]) : null;
  }
  async purgeEntriesBefore(cutoff: Date, at: Date) {
    let n = 0;
    for (const b of this.batches.values()) {
      if (b.generatedAt < cutoff && !b.entriesPurgedAt) {
        b.entries = [];
        b.entriesPurgedAt = at;
        n += 1;
      }
    }
    return n;
  }
}
