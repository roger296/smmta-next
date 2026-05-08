/**
 * AES-256-GCM at-rest encryption for opaque secrets (e.g. supplier API
 * keys). The encryption key is derived once from `ENCRYPTION_KEY` if
 * set, otherwise from `JWT_SECRET` via scrypt — so an existing
 * deployment that only has `JWT_SECRET` configured still gets
 * deterministic, repeatable encryption without operator intervention,
 * and operators who want a separately-rotatable key can set
 * `ENCRYPTION_KEY` directly.
 *
 * Storage format: `<iv-hex>:<authTag-hex>:<ciphertext-hex>` — three
 * colon-separated hex strings. The IV is 12 bytes (NIST recommendation
 * for GCM); the auth tag is 16 bytes.
 *
 * AES-256-GCM is authenticated: the `decrypt` call verifies the auth
 * tag and throws if the ciphertext was tampered with. Callers only
 * need to handle the throw, not separately validate.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
/** Fixed salt for the key-derivation step. The salt doesn't need to be
 *  per-secret because the IV is — every encrypted blob has its own IV. */
const KDF_SALT = Buffer.from('smmta-encrypt-v1', 'utf8');

let cachedKey: Buffer | null = null;

function deriveKey(): Buffer {
  if (cachedKey) return cachedKey;
  const direct = process.env.ENCRYPTION_KEY?.trim();
  if (direct) {
    // Operator supplied a dedicated key. We still scrypt-derive it to a
    // 32-byte buffer so any input string length works.
    cachedKey = scryptSync(direct, KDF_SALT, KEY_BYTES);
    return cachedKey;
  }
  const fallback = process.env.JWT_SECRET?.trim();
  if (!fallback) {
    throw new Error(
      'encrypt(): neither ENCRYPTION_KEY nor JWT_SECRET is set; cannot derive encryption key',
    );
  }
  cachedKey = scryptSync(fallback, KDF_SALT, KEY_BYTES);
  return cachedKey;
}

export function resetCryptoForTests(): void {
  cachedKey = null;
}

export function encrypt(plaintext: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encrypt(): plaintext must be a non-empty string');
  }
  const key = deriveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

export function decrypt(stored: string): string {
  if (typeof stored !== 'string') {
    throw new Error('decrypt(): stored value must be a string');
  }
  const parts = stored.split(':');
  if (parts.length !== 3) {
    throw new Error('decrypt(): malformed ciphertext envelope');
  }
  const [ivHex, tagHex, ctHex] = parts;
  let iv: Buffer;
  let tag: Buffer;
  let ct: Buffer;
  try {
    iv = Buffer.from(ivHex!, 'hex');
    tag = Buffer.from(tagHex!, 'hex');
    ct = Buffer.from(ctHex!, 'hex');
  } catch {
    throw new Error('decrypt(): malformed ciphertext envelope');
  }
  if (iv.length !== IV_BYTES) {
    throw new Error(`decrypt(): IV must be ${IV_BYTES} bytes, got ${iv.length}`);
  }
  if (tag.length !== 16) {
    throw new Error(`decrypt(): auth tag must be 16 bytes, got ${tag.length}`);
  }
  const key = deriveKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  // throws on bad tag
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * Constant-time compare for cases where two encrypted blobs might be
 * compared (e.g. detect whether a re-encryption produced an identical
 * envelope, which it never should — the IV is random per call).
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
