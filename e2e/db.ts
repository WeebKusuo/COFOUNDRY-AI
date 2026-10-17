import fs from 'node:fs';
import mongoose from 'mongoose';
import { STATE_FILE } from './shared';

/** Direct database access for E2E assertions (the server under test uses the same database). */
export async function withDb<T>(fn: (db: mongoose.mongo.Db) => Promise<T>): Promise<T> {
  const { mongodbUri } = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { mongodbUri: string };
  const conn = await mongoose.createConnection(mongodbUri).asPromise();
  try {
    return await fn(conn.db!);
  } finally {
    await conn.close();
  }
}

export async function userIdFor(email: string): Promise<string> {
  return withDb(async (db) => {
    const user = await db.collection('users').findOne({ emailLower: email });
    if (!user) throw new Error(`no user ${email}`);
    return user._id.toHexString();
  });
}
