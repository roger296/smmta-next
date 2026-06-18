import {
  pgTable,
  varchar,
  uuid,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { pk, companyId, auditTimestamps } from './common.js';

// ============================================================
// Xero integration (spec §A8) — GL re-point from Luca to Xero
// ============================================================

/**
 * Per-tenant Xero OAuth2 token state. Xero rotates the refresh token on every
 * refresh, so it must live in a writable store, not env. Access + refresh
 * tokens are AES-256-GCM encrypted (shared/crypto/encrypt.ts). App creds
 * (client id/secret) stay in env.
 */
export const xeroConnections = pgTable(
  'xero_connections',
  {
    id: pk(),
    companyId: companyId(),
    /** Xero tenant (organisation) id. */
    tenantId: varchar('tenant_id', { length: 100 }).notNull(),
    accessTokenEnc: text('access_token_enc'),
    refreshTokenEnc: text('refresh_token_enc'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    scopes: text('scopes'),
    ...auditTimestamps,
  },
  (t) => ({
    xeroConnectionsCompanyTenantUnq: uniqueIndex('xero_connections_company_tenant_unq').on(
      t.companyId,
      t.tenantId,
    ),
  }),
);

/**
 * Admin-editable map from a logical GL account role (STOCK, COGS, GRNI_ACCRUAL,
 * WASTAGE_WRITE_OFF, …) to the Xero account code + tax type for this
 * deployment. Seeded from the LUCA_ACCOUNTS names; operators remap to their
 * own chart of accounts in the admin UI.
 */
export const xeroAccountMap = pgTable(
  'xero_account_map',
  {
    id: pk(),
    companyId: companyId(),
    role: varchar('role', { length: 60 }).notNull(),
    xeroAccountCode: varchar('xero_account_code', { length: 20 }).notNull(),
    xeroTaxType: varchar('xero_tax_type', { length: 40 }),
    ...auditTimestamps,
  },
  (t) => ({
    xeroAccountMapCompanyRoleUnq: uniqueIndex('xero_account_map_company_role_unq').on(
      t.companyId,
      t.role,
    ),
  }),
);
