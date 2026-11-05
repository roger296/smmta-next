import { sql } from 'drizzle-orm';
import { pgTable, varchar, text, timestamp, uniqueIndex, uuid, integer, boolean, index, type AnyPgColumn } from 'drizzle-orm/pg-core';
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
    /** Optional FK to channels.id. When set, this api-key is scoped to a
     *  single channel — storefront read endpoints will filter the catalogue
     *  to products offered on that channel and use the channel-specific
     *  price. NULL means "see everything" (back-compat, and what
     *  generic operator keys want). */
    channelId: uuid('channel_id'),
    /** The admin user an `admin:mcp` key acts as. The MCP connector runs the
     *  admin's own routes signed in as this user, so the key can do exactly
     *  what that person can do in the web UI, and their actions are recorded
     *  under that person. Null for every other kind of key. */
    actingUserId: uuid('acting_user_id').references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    ...auditTimestamps,
  },
  (t) => ({
    apiKeysCompanyNameUnq: uniqueIndex('api_keys_company_id_name_unq').on(t.companyId, t.name),
    apiKeysPrefixIdx: uniqueIndex('api_keys_prefix_unq').on(t.prefix),
  }),
);

// ============================================================
// Users
// ------------------------------------------------------------
// Admin operators who log in via the SPA. The login endpoint
// (`POST /api/v1/auth/login`) verifies email + password against
// this table and issues a JWT. The JWT format is unchanged from
// the previous paste-a-token flow; only the issuance mechanism
// changes.
//
// Password hashing uses Node's `crypto.scrypt`, same format as
// `api_keys.key_hash`: `<salt-hex>:<hash-hex>`.
// ============================================================

export const users = pgTable('users', {
  id: pk(),
  companyId: companyId(),
  email: varchar('email', { length: 320 }).notNull().unique(),
  /** scrypt-derived password, formatted `<salt-hex>:<hash-hex>`. */
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  roles: text('roles')
    .array()
    .notNull()
    .default(sql`ARRAY['admin']::text[]`),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  ...auditTimestamps,
});

// ============================================================
// MCP audit
// ------------------------------------------------------------
// One row per admin MCP tool call: which key, as which user, which
// route, and the HTTP status it got. Bodies are not stored (they can
// carry customer details); the route and status are enough to trace
// what was done, and the route's own records hold the detail.
// ============================================================

export const mcpAudit = pgTable(
  'mcp_audit',
  {
    id: pk(),
    companyId: companyId(),
    keyPrefix: varchar('key_prefix', { length: 16 }).notNull(),
    userId: uuid('user_id'),
    tool: varchar('tool', { length: 80 }).notNull(),
    method: varchar('method', { length: 8 }).notNull(),
    path: text('path').notNull(),
    status: integer('status').notNull(),
    ok: boolean('ok').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdIdx: index('mcp_audit_created_idx').on(t.createdAt),
  }),
);
