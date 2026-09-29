/**
 * A supplier's account at each venue (supplier-ordering groundwork, Sept 2026;
 * plan §3.2): account number, delivery round or lead time, cut-off, minimum
 * order, delivery charge. What the ordering screen needs to say when an order
 * placed now would ARRIVE, and what it really costs.
 */
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { sites, suppliers, supplierSiteAccounts } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { nextDelivery, type NextDelivery } from './delivery-calendar.js';

export type SupplierSiteAccount = typeof supplierSiteAccounts.$inferSelect;

export interface SiteAccountView {
  site: { id: string; name: string; timezone: string };
  /** null = no account recorded for this venue yet. */
  account: SupplierSiteAccount | null;
  /** If ordered now. null when there is no account, it is switched off, or it
   *  describes neither a round nor a lead time. */
  nextDelivery: NextDelivery | null;
}

export interface SiteAccountInput {
  accountNumber?: string | null;
  ediLocationId?: string | null;
  deliveryDays?: string[];
  cutoffTime?: string | null;
  cutoffDaysBefore?: number;
  leadDays?: number | null;
  minOrderValue?: number | null;
  deliveryCharge?: number | null;
  freeDeliveryOver?: number | null;
  orderEmail?: string | null;
  portalUrl?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

const money = (v: number | null | undefined): string | null | undefined =>
  v === undefined ? undefined : v === null ? null : v.toFixed(2);
const blankToNull = (v: string | null | undefined): string | null | undefined =>
  v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim();

export class SupplierNotFoundError extends Error {}
export class SiteNotFoundError extends Error {}

export class SupplierSiteAccountService {
  private db = getDb();

  /** Every active venue, with this supplier's account there (or null). */
  async listForSupplier(
    supplierId: string,
    companyId = getSingletonCompanyId(),
    now = new Date(),
  ): Promise<SiteAccountView[]> {
    const allSites = await this.db
      .select({ id: sites.id, name: sites.name, timezone: sites.timezone })
      .from(sites)
      .where(and(eq(sites.companyId, companyId), eq(sites.isActive, true)))
      .orderBy(asc(sites.name));
    const accounts = await this.db
      .select()
      .from(supplierSiteAccounts)
      .where(and(eq(supplierSiteAccounts.companyId, companyId), eq(supplierSiteAccounts.supplierId, supplierId)));
    const bySite = new Map(accounts.map((a) => [a.siteId, a]));
    return allSites.map((site) => {
      const account = bySite.get(site.id) ?? null;
      return {
        site,
        account,
        nextDelivery: account?.isActive ? nextDelivery(account, now, site.timezone) : null,
      };
    });
  }

  /** Create or update the account for one (supplier, site). A field left out
   *  of `input` is left as it is; null clears it. */
  async upsert(
    supplierId: string,
    siteId: string,
    input: SiteAccountInput,
    companyId = getSingletonCompanyId(),
  ): Promise<SupplierSiteAccount> {
    const supplier = await this.db.query.suppliers.findFirst({
      where: and(eq(suppliers.id, supplierId), eq(suppliers.companyId, companyId)),
      columns: { id: true },
    });
    if (!supplier) throw new SupplierNotFoundError('Supplier not found');
    const site = await this.db.query.sites.findFirst({
      where: and(eq(sites.id, siteId), eq(sites.companyId, companyId)),
      columns: { id: true },
    });
    if (!site) throw new SiteNotFoundError('Site not found');

    const values = {
      accountNumber: blankToNull(input.accountNumber),
      ediLocationId: blankToNull(input.ediLocationId),
      deliveryDays:
        input.deliveryDays === undefined
          ? undefined
          : [...new Set(input.deliveryDays.map((d) => d.toUpperCase()))],
      cutoffTime: blankToNull(input.cutoffTime),
      cutoffDaysBefore: input.cutoffDaysBefore,
      leadDays: input.leadDays,
      minOrderValue: money(input.minOrderValue),
      deliveryCharge: money(input.deliveryCharge),
      freeDeliveryOver: money(input.freeDeliveryOver),
      orderEmail: blankToNull(input.orderEmail),
      portalUrl: blankToNull(input.portalUrl),
      notes: blankToNull(input.notes),
      isActive: input.isActive,
    };
    const set = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));

    const [row] = await this.db
      .insert(supplierSiteAccounts)
      .values({ companyId, supplierId, siteId, ...set })
      .onConflictDoUpdate({
        target: [supplierSiteAccounts.companyId, supplierSiteAccounts.supplierId, supplierSiteAccounts.siteId],
        set: { ...set, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }
}
