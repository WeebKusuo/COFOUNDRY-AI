import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify, type Algorithm } from '@node-rs/argon2';
import { PASSWORD_LIMITS } from '@cofoundry/shared';

/** `Algorithm.Argon2id` — the enum is a const enum, so its value is spelled out here. */
const ARGON2ID = 2 as Algorithm;

/**
 * Section 22: Argon2id, memory 64 MiB, iterations 3, parallelism 1, unique salt per hash
 * (the library generates a random salt and encodes it in the PHC string).
 */
export const ARGON2_PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;

export class PasswordPolicyError extends Error {}

export function assertPasswordPolicy(password: string): void {
  const length = Array.from(password).length;
  if (length < PASSWORD_LIMITS.min || length > PASSWORD_LIMITS.max) {
    throw new PasswordPolicyError(
      `Passwords must be ${PASSWORD_LIMITS.min}-${PASSWORD_LIMITS.max} characters.`,
    );
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  return hash(password, ARGON2_PARAMS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Verifies against a fixed dummy hash so unknown accounts take as long as wrong passwords —
 * the response time must not reveal which emails exist.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hash('dummy-password-for-timing', ARGON2_PARAMS);
  await verifyPassword(await dummyHash, password);
}

/** 32 random bytes, base64url — the raw value only ever lives in the cookie or the response. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of a presented secret against a stored SHA-256 hex digest. */
export function matchesHash(presented: string, storedHashHex: string): boolean {
  const a = Buffer.from(sha256(presented), 'hex');
  const b = Buffer.from(storedHashHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
