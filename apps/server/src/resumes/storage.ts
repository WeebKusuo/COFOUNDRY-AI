import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Private file storage for resume originals. Keys are random server-generated identifiers, never
 * derived from user input, and are never returned to clients. Production can supply another
 * implementation (for example self-hosted object storage) behind the same interface.
 */
export interface ResumeFileStorage {
  /** Stores bytes under a new key and returns the key. */
  put(bytes: Uint8Array): Promise<string>;
  get(key: string): Promise<Buffer | null>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
}

const KEY = /^[a-f0-9]{32}$/;

function assertKey(key: string): void {
  if (!KEY.test(key)) throw new Error('invalid storage key');
}

/**
 * Local-disk storage in a private directory (created 0700, files 0600) that is not served by
 * the web server: static serving is limited to the SPA build directory. Writes go to a temporary
 * name first and are renamed into place, so a crash never leaves a partial file under a key.
 */
export function createLocalFileStorage(dir: string): ResumeFileStorage {
  const root = path.resolve(dir);
  let ready: Promise<void> | null = null;
  const ensureDir = () => {
    ready ??= fs.mkdir(root, { recursive: true, mode: 0o700 }).then(() => undefined);
    return ready;
  };
  const fileFor = (key: string) => {
    assertKey(key);
    return path.join(root, `${key}.pdf`);
  };

  return {
    async put(bytes) {
      await ensureDir();
      const key = randomBytes(16).toString('hex');
      const tmp = path.join(root, `.${key}.tmp`);
      await fs.writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
      await fs.rename(tmp, fileFor(key));
      return key;
    },
    async get(key) {
      try {
        return await fs.readFile(fileFor(key));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async delete(key) {
      try {
        await fs.unlink(fileFor(key));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    },
  };
}

/** In-memory storage for tests and local tooling. */
export function createMemoryFileStorage(): ResumeFileStorage & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    async put(bytes) {
      const key = randomBytes(16).toString('hex');
      files.set(key, Buffer.from(bytes));
      return key;
    },
    async get(key) {
      assertKey(key);
      return files.get(key) ?? null;
    },
    async delete(key) {
      assertKey(key);
      files.delete(key);
    },
  };
}
