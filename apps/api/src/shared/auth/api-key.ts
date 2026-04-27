/**
 * API key generation, hashing, and parsing helpers.
 *
 * Hashing choice: Node's built-in `crypto.scrypt`. The architecture
 * document mentions argon2id; the build prompt allows scrypt as an
 * alternative when argon2 isn't already a dependency. argon2 is a
 * native module that requires platform build tools — scrypt avoids
 * that and is acceptably strong for a service token.
 *
 * Key format
 *   smmta_<prefix-8hex>_<secret-32hex>
 *
 * - prefix: stored verbatim, used as the initial DB lookup before
 *   constant-time hash verification of the secret.
 * - secret: never stored; only its scrypt hash (with a 16-byte
 *   per-key random salt) is persisted, formatted `<saltHex>:<hashHex>`.
 *
 * Total raw-key length: 6 + 8 + 1 + 32 = 47 chars.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as unknown as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/** Length of the prefix portion in hex characters. */
export const KEY_PREFIX_LENGTH = 8;

/** Length of the secret portion in hex characters. */
export const KEY_SECRET_LENGTH = 32;

/** Hash output length in bytes. 64 → 128 hex chars. */
const HASH_KEYLEN = 64;

/** Salt length in bytes. */
const SALT_BYTES = 16;

/** Pattern that matches well-formed raw keys exactly. */
const RAW_KEY_REGEX = new RegExp(
  `^smmta_([0-9a-f]{${KEY_PREFIX_LENGTH}})_([0-9a-f]{${KEY_SECRET_LENGTH}})$`,
);

/**
 * Generate a fresh API key. The caller is responsible for hashing the
 * secret with `hashSecret` before persisting, and for returning `raw`
 * to the user exactly once.
 */
export function generateApiKey(): { raw: string; prefix: string; secret: string } {
  const prefix = randomBytes(KEY_PREFIX_LENGTH / 2).toString('hex'); // 4 bytes → 8 hex
  const secret = randomBytes(KEY_SECRET_LENGTH / 2).toString('hex'); // 16 bytes → 32 hex
  const raw = `smmta_${prefix}_${secret}`;
  return { raw, prefix, secret };
}

/**
 * scrypt-hash a secret with a fresh random salt. Returns a string that
 * can be stored in `api_keys.key_hash` and later passed back to
 * `verifySecret`.
 */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(secret, salt, HASH_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Constant-time-verify a candidate secret against a `<saltHex>:<hashHex>`
 * string from the database.
 */
export async function verifySecret(secret: string, stored: string): Promise<boolean> {
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

  const actual = await scrypt(secret, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Parse a raw key into its prefix and secret components, or return
 * `null` if the key is malformed.
 */
export function parseRawKey(raw: string): { prefix: string; secret: string } | null {
  const m = RAW_KEY_REGEX.exec(raw);
  if (!m) return null;
  return { prefix: m[1] as string, secret: m[2] as string };
}
