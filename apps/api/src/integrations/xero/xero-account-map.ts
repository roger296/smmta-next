/**
 * Logical GL account roles → Xero account code + tax type (spec §A8).
 *
 * Defaults mirror the LUCA_ACCOUNTS names so a fresh deployment is sane; the
 * `xero_account_map` table holds per-company overrides an operator edits in the
 * admin UI to match their own Xero chart of accounts. `resolveXeroAccount`
 * returns the override if present, else the default.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { xeroAccountMap } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

export interface XeroAccount {
  code: string;
  taxType: string;
}

/** The logical roles the GL journals reference. */
export type XeroAccountRole =
  | 'STOCK'
  | 'COGS'
  | 'CONSUMPTION_COGS'
  | 'WASTAGE_WRITE_OFF'
  | 'STOCK_WRITE_OFFS'
  | 'STOCK_WRITE_BACK'
  | 'GRNI_ACCRUAL'
  | 'DELIVERY_GRNI_ACCRUAL'
  | 'SERVICE_GRNI_ACCRUAL'
  | 'SALES_REVENUE'
  | 'TRADE_DEBTORS'
  | 'TRADE_CREDITORS'
  | 'VAT_INPUT'
  | 'VAT_OUTPUT';

/** Defaults seeded from the LUCA_ACCOUNTS codes. Tax type `NONE` for
 *  balance-sheet / COGS roles (VAT is carried on dedicated VAT roles). */
export const XERO_ACCOUNT_DEFAULTS: Record<XeroAccountRole, XeroAccount> = {
  STOCK: { code: '1150', taxType: 'NONE' },
  COGS: { code: '5000', taxType: 'NONE' },
  CONSUMPTION_COGS: { code: '5000', taxType: 'NONE' },
  WASTAGE_WRITE_OFF: { code: '5010', taxType: 'NONE' },
  STOCK_WRITE_OFFS: { code: '5010', taxType: 'NONE' },
  STOCK_WRITE_BACK: { code: '5020', taxType: 'NONE' },
  GRNI_ACCRUAL: { code: '2310', taxType: 'NONE' },
  DELIVERY_GRNI_ACCRUAL: { code: '2320', taxType: 'NONE' },
  SERVICE_GRNI_ACCRUAL: { code: '2330', taxType: 'NONE' },
  SALES_REVENUE: { code: '4000', taxType: 'OUTPUT2' },
  TRADE_DEBTORS: { code: '1100', taxType: 'NONE' },
  TRADE_CREDITORS: { code: '2000', taxType: 'NONE' },
  VAT_INPUT: { code: '1200', taxType: 'NONE' },
  VAT_OUTPUT: { code: '2100', taxType: 'NONE' },
};

export const XERO_ACCOUNT_ROLES = Object.keys(XERO_ACCOUNT_DEFAULTS) as XeroAccountRole[];

interface DbLike {
  query: ReturnType<typeof getDb>['query'];
}

/** Resolve a role to its Xero account (DB override → default). */
export async function resolveXeroAccount(
  role: XeroAccountRole,
  companyId = getSingletonCompanyId(),
  db: DbLike = getDb(),
): Promise<XeroAccount> {
  const override = await db.query.xeroAccountMap.findFirst({
    where: and(eq(xeroAccountMap.companyId, companyId), eq(xeroAccountMap.role, role)),
  });
  if (override) {
    return { code: override.xeroAccountCode, taxType: override.xeroTaxType ?? 'NONE' };
  }
  const fallback = XERO_ACCOUNT_DEFAULTS[role];
  if (!fallback) throw new Error(`No Xero account mapping for role "${role}"`);
  return fallback;
}

/** Idempotently seed the default map rows for a company (admin can then edit). */
export async function ensureXeroAccountMapSeeded(companyId = getSingletonCompanyId()): Promise<void> {
  const db = getDb();
  for (const role of XERO_ACCOUNT_ROLES) {
    const def = XERO_ACCOUNT_DEFAULTS[role];
    await db
      .insert(xeroAccountMap)
      .values({ companyId, role, xeroAccountCode: def.code, xeroTaxType: def.taxType })
      .onConflictDoNothing({ target: [xeroAccountMap.companyId, xeroAccountMap.role] });
  }
}
