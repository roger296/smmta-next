/**
 * Buying-data health (supplier-ordering groundwork). Real Postgres, isolated
 * company. Each list catches exactly the case it names and nothing else.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  products,
  sites,
  stockLevels,
  supplierPriceObservations,
  supplierProducts,
  supplierSiteAccounts,
  suppliers,
} from '../../db/schema/index.js';
import { buyingDataHealth, type BuyingDataHealth } from './buying-data-health.service.js';

const COMPANY = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4';
const ids: Record<string, string> = {};
let health: BuyingDataHealth;

async function wipe(): Promise<void> {
  const db = getDb();
  await db.delete(supplierProducts).where(eq(supplierProducts.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
  await db.delete(suppliers).where(eq(suppliers.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

beforeAll(async () => {
  const db = getDb();
  await wipe();
  const product = async (key: string, over: Partial<typeof products.$inferInsert> = {}) => {
    const [p] = await db.insert(products).values({ companyId: COMPANY, name: `BD ${key}`, slug: `bd-${key}`, ...over }).returning();
    ids[key] = p!.id;
  };
  await product('orphan');
  await product('orphan-reorder');
  await product('not-stocked', { isStocked: false });
  await product('flour');
  await product('sugar');
  await product('butter');

  const [east] = await db.insert(sites).values({ companyId: COMPANY, slug: 'bd-east', name: 'BD East', canonicalName: 'BD East' }).returning();
  await db.insert(sites).values({ companyId: COMPANY, slug: 'bd-south', name: 'BD South', canonicalName: 'BD South' });
  await db.insert(stockLevels).values({ companyId: COMPANY, productId: ids['orphan-reorder']!, siteId: east!.id, onHand: '0', reorderPoint: '5' });

  const [brakes] = await db.insert(suppliers).values({ companyId: COMPANY, name: 'BD Brakes' }).returning();
  const [booker] = await db.insert(suppliers).values({ companyId: COMPANY, name: 'BD Booker' }).returning();
  ids.brakes = brakes!.id;
  ids.booker = booker!.id;
  // Brakes can be dated at one venue of two; Booker at none.
  await db.insert(supplierSiteAccounts).values({ companyId: COMPANY, supplierId: brakes!.id, siteId: east!.id, deliveryDays: ['TUE'] });

  const option = async (key: string, over: Partial<typeof supplierProducts.$inferInsert>) => {
    const [m] = await db
      .insert(supplierProducts)
      .values({ companyId: COMPANY, supplierId: brakes!.id, supplierSku: key, productId: ids.flour!, ...over })
      .returning();
    ids[key] = m!.id;
  };
  // Flour: pack known, price fresh and steady.
  await option('FLOUR-16', { supplierPackSize: '16', costGbp: '11.00' });
  // Sugar: no pack size, a stale price that jumped 25%.
  await option('SUGAR-25', { productId: ids.sugar!, costGbp: '20.00' });
  // Butter: no pack, no cost, never invoiced.
  await option('BUTTER-1', { productId: ids.butter!, supplierId: booker!.id });
  // The inert placeholder is ignored everywhere.
  await option('NOSKU', { productId: ids.butter! });

  const obs = (key: string, price: string, at: Date, qty = 1) => ({
    companyId: COMPANY,
    supplierProductId: ids[key]!,
    supplierId: brakes!.id,
    source: 'INVOICE' as const,
    unitPrice: price,
    quantity: String(qty),
    observedAt: at,
  });
  await db.insert(supplierPriceObservations).values([
    obs('FLOUR-16', '11.00', daysAgo(40), 10),
    obs('FLOUR-16', '11.20', daysAgo(5), 10),
    obs('SUGAR-25', '20.00', daysAgo(200), 2),
    obs('SUGAR-25', '25.00', daysAgo(90), 2),
  ]);

  health = await buyingDataHealth(COMPANY);
});

afterAll(async () => {
  await wipe();
  await closeDatabase();
});

const skus = (l: { rows: Array<{ supplierSku: string }> }) => l.rows.map((r) => r.supplierSku).sort();

describe('buying-data health', () => {
  it('stocked products with nothing to buy, reorder-point ones first', () => {
    expect(health.noBuyingOption.rows.map((r) => [r.productName, r.hasReorderPoint])).toEqual([
      ['BD orphan-reorder', true],
      ['BD orphan', false],
    ]);
  });

  it('options with no pack size, biggest spend first; the NOSKU placeholder is ignored', () => {
    expect(health.packSizeMissing.rows.map((r) => r.supplierSku)).toEqual(['SUGAR-25', 'BUTTER-1']);
    expect(health.packSizeMissing.rows[0]!.spendSeen12m).toBe(90); // 2 × £20 + 2 × £25
  });

  it('no typed cost and never invoiced', () => {
    expect(skus(health.noPrice)).toEqual(['BUTTER-1']);
  });

  it('last invoiced more than 60 days ago', () => {
    expect(skus(health.stalePrice)).toEqual(['SUGAR-25']);
  });

  it('a move of more than 10% between the last two invoices, and not a 2% one', () => {
    expect(health.priceMoves.rows.map((r) => [r.supplierSku, Math.round(r.change * 100)])).toEqual([['SUGAR-25', 25]]);
  });

  it('suppliers that cannot be dated at every venue', () => {
    expect(health.supplierAccounts.rows.map((r) => [r.supplierName, r.venuesDatable, r.venues])).toEqual([
      ['BD Brakes', 1, 2],
      ['BD Booker', 0, 2],
    ]);
  });

  it('every list says its full size', () => {
    expect(health.noBuyingOption.total).toBe(2);
    expect(health.thresholds).toEqual({ stalePriceDays: 60, priceMoveAlert: 0.1 });
  });
});
