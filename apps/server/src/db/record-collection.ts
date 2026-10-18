import mongoose, { type Connection, type mongo } from 'mongoose';
import { sessionOpt, type Tx } from './transactions.js';

/**
 * Small helper over the native driver for collections whose records have a hex `id` and a
 * `rev` counter (Phases 11-14). Listed top-level id fields are stored as ObjectIds so they can be
 * indexed and joined like the rest of the schema; everything else is stored as-is.
 */

type AnyRecord = { id: string } & Record<string, unknown>;

export const oid = (id: string) => new mongoose.Types.ObjectId(id);
export const isDuplicateKey = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;

export class RecordCollection<R extends { id: string }> {
  constructor(
    private readonly conn: Connection,
    readonly name: string,
    /** Top-level fields holding ids (string | null) stored as ObjectId. */
    private readonly idFields: readonly (keyof R & string)[],
  ) {}

  col(): mongo.Collection<mongo.Document> {
    const db = this.conn.db;
    if (!db) throw new Error('database not connected');
    return db.collection(this.name);
  }

  toDoc(r: R): mongo.Document {
    const { id, ...rest } = r as unknown as AnyRecord;
    const doc: mongo.Document = { _id: oid(id), ...rest };
    for (const f of this.idFields) {
      const v = (r as unknown as AnyRecord)[f];
      doc[f] = typeof v === 'string' ? oid(v) : v;
    }
    return doc;
  }

  fromDoc(d: mongo.Document): R {
    const { _id, ...rest } = d;
    const out: Record<string, unknown> = {
      id: (_id as mongoose.Types.ObjectId).toHexString(),
      ...rest,
    };
    for (const f of this.idFields as readonly string[]) {
      const v = out[f];
      if (v instanceof mongoose.Types.ObjectId) out[f] = v.toHexString();
    }
    return out as unknown as R;
  }

  /** Converts `{ field: hexId }` filter values for id fields to ObjectIds. */
  filter(q: Record<string, unknown>): mongo.Filter<mongo.Document> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(q)) {
      if (k === 'id') out._id = typeof v === 'string' ? oid(v) : v;
      else if ((this.idFields as readonly string[]).includes(k) && typeof v === 'string')
        out[k] = oid(v);
      else out[k] = v;
    }
    return out;
  }

  /** 'created', 'exists' (same id: idempotent retry) or 'duplicate' (another unique key). */
  async insert(r: R, tx?: Tx): Promise<'created' | 'exists' | 'duplicate'> {
    try {
      await this.col().insertOne(this.toDoc(r), sessionOpt(tx));
      return 'created';
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // In a transaction the write error aborts it; callers re-read outside or rethrow.
      if (tx?.session) throw err;
      const same = await this.col().findOne({ _id: oid(r.id) });
      return same ? 'exists' : 'duplicate';
    }
  }

  async findById(id: string, tx?: Tx): Promise<R | null> {
    const d = await this.col().findOne({ _id: oid(id) }, sessionOpt(tx));
    return d ? this.fromDoc(d) : null;
  }

  async findOne(q: Record<string, unknown>, tx?: Tx): Promise<R | null> {
    const d = await this.col().findOne(this.filter(q), sessionOpt(tx));
    return d ? this.fromDoc(d) : null;
  }

  async find(
    q: Record<string, unknown>,
    options: { sort?: mongo.Sort; limit?: number; tx?: Tx } = {},
  ): Promise<R[]> {
    let cursor = this.col().find(this.filter(q), sessionOpt(options.tx));
    if (options.sort) cursor = cursor.sort(options.sort);
    if (options.limit) cursor = cursor.limit(options.limit);
    return (await cursor.toArray()).map((d) => this.fromDoc(d));
  }

  /** Writes `next` with rev = expectedRev + 1 only if the stored rev equals expectedRev. */
  async replace(next: R & { rev: number }, expectedRev: number, tx?: Tx): Promise<R | null> {
    const doc = this.toDoc({ ...next, rev: expectedRev + 1 });
    const { _id, ...body } = doc;
    const res = await this.col().findOneAndReplace({ _id, rev: expectedRev }, body, {
      returnDocument: 'after',
      ...sessionOpt(tx),
    });
    return res ? this.fromDoc(res) : null;
  }

  async count(q: Record<string, unknown>): Promise<number> {
    return this.col().countDocuments(this.filter(q));
  }
}

/** Newest-first keyset page over (createdAt, _id). */
export function pageFilter(after: { createdAt: Date; id: string } | null): Record<string, unknown> {
  if (!after) return {};
  return {
    $or: [
      { createdAt: { $lt: after.createdAt } },
      { createdAt: after.createdAt, _id: { $lt: oid(after.id) } },
    ],
  };
}
