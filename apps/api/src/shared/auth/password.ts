/**
 * Password hashing for the admin user store.
 *
 * Hashing choice: Node's built-in `crypto.scrypt`, matching the
 * existing `api_keys` choice (consistency over fashion). Salt + hash
 * are stored together in a single column as `<salt-hex>:<hash-hex>`.
 *
 * The CPU cost parameter `N=2^15` (32768) is the value Node's docs
 * recommend for password hashing on modern hardware. Increase if
 * you're seeing logins finish in <100ms; lower it if you're seeing
 * timeouts on a small VPS.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as unknown as (
  password: string,
  salt: Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

/** Hash output length in bytes. 64 → 128 hex chars. */
const HASH_KEYLEN = 64;

/** Salt length in bytes. */
const SALT_BYTES = 16;

/** scrypt cost parameters. */
const SCRYPT_OPTS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('hashPassword: plain must be a non-empty string');
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(plain, salt, HASH_KEYLEN, SCRYPT_OPTS);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  const colon = stored.indexOf(':');
  if (colon <= 0 || colon === stored.length - 1) return false;
  const saltHex = stored.slice(0, colon);
  const hashHex = stored.slice(colon + 1);
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = await scrypt(plain, salt, expected.length, SCRYPT_OPTS);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
