import type { CurrentResume, ResumeRecord, ResumeStore } from '../../src/resumes/store.js';

interface Row {
  version: number;
  current: CurrentResume | null;
  text: string;
}

/** In-memory ResumeStore with the same conditional-write semantics as the Mongo store. */
export class MemoryResumeStore implements ResumeStore {
  rows = new Map<string, Row>();

  private record(userId: string, row: Row): ResumeRecord {
    return {
      userId,
      version: row.version,
      current: row.current ? structuredClone(row.current) : null,
    };
  }

  async find(userId: string) {
    const row = this.rows.get(userId);
    return row ? this.record(userId, row) : null;
  }

  async findWithText(userId: string) {
    const row = this.rows.get(userId);
    if (!row?.current) return null;
    return { version: row.version, current: structuredClone(row.current), text: row.text };
  }

  async save(userId: string, expectedVersion: number, current: CurrentResume, text: string) {
    const row = this.rows.get(userId);
    if ((row?.version ?? 0) !== expectedVersion) return 'conflict' as const;
    const replacedStorageKey = row?.current?.storageKey ?? null;
    const next: Row = { version: expectedVersion + 1, current: structuredClone(current), text };
    this.rows.set(userId, next);
    return { record: this.record(userId, next), replacedStorageKey };
  }

  async clear(userId: string) {
    const row = this.rows.get(userId);
    if (!row?.current) return null;
    const key = row.current.storageKey;
    row.current = null;
    row.text = '';
    row.version += 1;
    return key;
  }
}
