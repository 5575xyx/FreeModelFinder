import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Management-panel password verifier persisted in config.
 *
 * The stored value is an scrypt hash, not a recoverable secret, so it is kept
 * alongside the rest of the config rather than under the master key. Anyone
 * who reads config.json cannot recover the password — they can only replay a
 * guess against the hash.
 */
export interface AdminAuthSettings {
  passwordHash: string;
  passwordSalt: string;
  createdAt: number;
}

/**
 * Cost parameters. N is low enough that a password write during interactive
 * CLI use feels instant, high enough to keep offline cracking expensive.
 * Bumping these later invalidates existing hashes and forces a reset.
 */
const SCRYPT_PARAMS = { cost: 16384, blockSize: 8, parallelization: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export const MIN_ADMIN_PASSWORD_LENGTH = 8;

export function assertAdminPasswordUsable(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`);
  }
}

function runScrypt(password: string, salt: string, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, SCRYPT_PARAMS, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashAdminPassword(
  password: string,
  createdAt = Date.now(),
): Promise<AdminAuthSettings> {
  assertAdminPasswordUsable(password);
  const passwordSalt = randomBytes(SALT_LENGTH).toString('base64');
  const passwordHash = (await runScrypt(password, passwordSalt, KEY_LENGTH)).toString('base64');
  return { passwordHash, passwordSalt, createdAt };
}

/**
 * Returns false rather than throwing on any malformed stored state. A
 * hand-edited config must be able to lock the panel out, never crash the
 * gateway — but it must also never silently report success.
 */
export async function verifyAdminPassword(
  password: string,
  admin?: Partial<AdminAuthSettings>,
): Promise<boolean> {
  if (typeof password !== 'string' || password.length === 0) return false;
  // Callers may hand over whatever JSON the config file contains, and `Partial`
  // is what `JSON.parse` would actually produce, so destructure before guarding.
  const { passwordHash, passwordSalt } = admin ?? {};
  if (!passwordHash || !passwordSalt) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(passwordHash, 'base64');
  } catch {
    return false;
  }
  // An undecodable hash would make scrypt throw on a wrong-length key. Fail
  // closed instead of leaking that shape difference to the caller.
  if (expected.length === 0) return false;

  try {
    const actual = await runScrypt(password, passwordSalt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
