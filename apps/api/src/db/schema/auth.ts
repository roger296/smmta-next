import { sql } from 'drizzle-orm';
import { pgTable, varchar, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { pk, companyId, auditTimestamps } from './common.js';

// ============================================================
// API Keys
// ------------------------------------------------------------
// Service-to-service authentication. The storefront and other
// service integrations authenticate to the SMMTA-NEXT API by
// presenting `Authorization: Bearer <raw key>`. Raw keys are
// never stored — only the scrypt hash and a short display
// prefix.
//
// Key format: `smmta_<8-char prefix>_<32-char secret>`
//   - prefix: stored verbatim, used as the row lookup key
//             before constant-time hash verification.
//   - secret: random; only the scrypt hash is stored.
//
// Hashing choice: Node's `crypto.scrypt` (no native deps, ships
// with Node). The architecture document mentions argon2id as a
// preferred option, but adding `argon2` would be a new top-level
// dependency on a native module (and a build-tools requirement
// on developer machines). scrypt is acceptably strong for this
// secret type; the choice is documented in `auth/api-key.ts`.
// ============================================================

export const apiKeys = pgTable(
  'api_keys',
  {
    id: pk(),
    companyId: companyId(),
    /** Operator-friendly name, e.g. `web-store-prod`. Unique per company. */
    name: varchar('name', { length: 120 }).notNull(),
    /** scrypt-derived key, formatted `<salt-hex>:<hash-hex>`. */
    keyHash: varchar('key_hash', { length: 255 }).notNull(),
    /** First 8 chars of the raw key, for display in admin UIs and the lookup
     *  index used to find a candidate row before constant-time verification. */
    prefix: varchar('prefix', { length: 16 }).notNull(),
    /** Permission scopes, e.g. `storefront:read`, `storefront:write`. */
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    ...auditTimestamps,
  },
  (t) => ({
    apiKeysCompanyNameUnq: uniqueIndex('api_keys_company_id_name_unq').on(t.companyId, t.name),
    apiKeysPrefixIdx: uniqueIndex('api_keys_prefix_unq').on(t.prefix),
  }),
);
