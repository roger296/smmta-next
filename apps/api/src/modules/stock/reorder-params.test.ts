/**
 * Reorder parameters + supplier auto-place (P6, spec §A7).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { products, sites, stockLevels } from '../../db/schema/index.js';
import { StockLevelService } from './stock-level.service.js';
import { StockQueryService } from './stock-query.service.js';
import { effectiveAutoPlace } from './supplier-products.js';

const COMPANY = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const levels = new StockLevelService();
const query = new StockQueryService();

let productId: string;
let siteAId: string;
let siteBId: string;

beforeAll(async () => {
  const db = getDb();
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  const [p] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Reorder Flour', slug: 'reorder-flour', itemKind: 'INGREDIENT', stockUom: 'g' })
    .returning();
  productId = p!.id;
  const [a] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'reorder-a', name: 'Reorder A', canonicalName: 'Reorder A' })
    .returning();
  const [b] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'reorder-b', name: 'Reorder B', canonicalName: 'Reorder B' })
    .returning();
  siteAId = a!.id;
  siteBId = b!.id;
});

afterAll(async () => {
  const db = getDb();
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  await closeDatabase();
});

describe('reorder parameters', () => {
  it('persist per (product, site), creating the row, and are site-independent', async () => {
    await levels.setReorderParams({
      productId,
      siteId: siteAId,
      reorderPoint: 2000,
      reorderUpTo: 8000,
      minDaysCover: 7,
      companyId: COMPANY,
    });
    await levels.setReorderParams({
      productId,
      siteId: siteBId,
      reorderPoint: 500,
      companyId: COMPANY,
    });

    const rows = await query.listLevels({ companyId: COMPANY });
    const a = rows.find((r) => r.siteId === siteAId)!;
    const b = rows.find((r) => r.siteId === siteBId)!;
    expect(Number(a.reorderPoint)).toBe(2000);
    expect(Number(a.reorderUpTo)).toBe(8000);
    expect(Number(b.reorderPoint)).toBe(500);
    // Site B's reorder-up-to was never set → stays null, independent of A.
    expect(b.reorderUpTo).toBeNull();
  });

  it('updates only the provided fields on a second call', async () => {
    await levels.setReorderParams({ productId, siteId: siteAId, reorderPoint: 3000, companyId: COMPANY });
    const rows = await query.listLevels({ siteId: siteAId, companyId: COMPANY });
    const a = rows[0]!;
    expect(Number(a.reorderPoint)).toBe(3000);
    expect(Number(a.reorderUpTo)).toBe(8000); // untouched
  });
});

describe('effective auto-place', () => {
  it('per-item override beats the supplier default', () => {
    // Supplier defaults to propose-for-approval, item forces auto-place.
    expect(effectiveAutoPlace({ autoPlaceOverride: true }, { autoPlace: false })).toBe(true);
    // Supplier defaults to auto-place, item forces propose.
    expect(effectiveAutoPlace({ autoPlaceOverride: false }, { autoPlace: true })).toBe(false);
    // No override → inherit the supplier default.
    expect(effectiveAutoPlace({ autoPlaceOverride: null }, { autoPlace: true })).toBe(true);
    expect(effectiveAutoPlace({ autoPlaceOverride: null }, { autoPlace: false })).toBe(false);
  });
});
