/**
 * Shared catalogue with BumbleBee (P11, spec §A4). Real Postgres, isolated.
 *
 * Covers: import is idempotent (re-run updates, never duplicates);
 * product_type → item_kind mapping; the slim-subset push is dry-run by default
 * (logs, sends nothing); reconciliation flags the right gaps.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { products } from '../../db/schema/index.js';
import {
  CatalogueSyncService,
  bumblebeeTypeToItemKind,
} from './catalogue-sync.service.js';

const COMPANY = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5';
const svc = new CatalogueSyncService();
// BumbleBee product ids are UUIDs (core.products.id).
const BB1 = '00000000-0000-4000-8000-0000000000b1';
const BB2 = '00000000-0000-4000-8000-0000000000b2';
const BB3 = '00000000-0000-4000-8000-0000000000b3';
const BB10 = '00000000-0000-4000-8000-0000000000ba';
const BB99 = '00000000-0000-4000-8000-0000000000c9';

async function clear(): Promise<void> {
  await getDb().delete(products).where(eq(products.companyId, COMPANY));
}

beforeEach(clear);
afterAll(async () => {
  await clear();
  await closeDatabase();
});

describe('bumblebeeTypeToItemKind', () => {
  it('maps known types and defaults unknown to RETAIL', () => {
    expect(bumblebeeTypeToItemKind('MERCH')).toBe('MERCH');
    expect(bumblebeeTypeToItemKind('INGREDIENT')).toBe('INGREDIENT');
    expect(bumblebeeTypeToItemKind('experience')).toBe('RETAIL');
    expect(bumblebeeTypeToItemKind('SOMETHING_NEW')).toBe('RETAIL');
    expect(bumblebeeTypeToItemKind(null)).toBe('RETAIL');
  });
});

describe('importProducts', () => {
  it('imports and is idempotent on re-run (updates, never duplicates)', async () => {
    const rows = [
      { bumblebeeProductId: BB1, name: 'White Flour', productType: 'INGREDIENT', costPrice: 0.5 },
      { bumblebeeProductId: BB2, name: 'Branded Cookie', productType: 'MERCH', defaultSalePrice: 3 },
    ];
    const first = await svc.importProducts(rows, COMPANY);
    expect(first.created).toBe(2);

    // Re-run with a changed name → update, not duplicate.
    const second = await svc.importProducts(
      [{ bumblebeeProductId: BB1, name: 'White Flour (updated)', productType: 'INGREDIENT' }],
      COMPANY,
    );
    expect(second.updated).toBe(1);
    expect(second.created).toBe(0);

    const all = await getDb().select().from(products).where(eq(products.companyId, COMPANY));
    expect(all).toHaveLength(2); // no duplicate
    const flour = all.find((p) => p.bumblebeeProductId === BB1)!;
    expect(flour.name).toBe('White Flour (updated)');
    expect(flour.itemKind).toBe('INGREDIENT');
  });
});

describe('pushSlimSubset', () => {
  it('is dry-run by default — builds the slim payload and sends nothing', async () => {
    await svc.importProducts(
      [{ bumblebeeProductId: BB3, name: 'Tote bag', productType: 'MERCH', defaultSalePrice: 8 }],
      COMPANY,
    );
    const res = await svc.pushSlimSubset(COMPANY);
    expect(res.dryRun).toBe(true);
    expect(res.count).toBeGreaterThanOrEqual(1);

    const slim = await svc.buildSlimSubset(COMPANY);
    const tote = slim.find((s) => s.bumblebeeProductId === BB3)!;
    expect(tote.name).toBe('Tote bag');
    expect(Object.keys(tote).sort()).toEqual(
      ['bumblebeeProductId', 'categoryId', 'name', 'salePrice'].sort(),
    );
  });
});

describe('reconcile', () => {
  it('flags unlinked Auto-Stock products and not-yet-stocked BumbleBee ids', async () => {
    await svc.importProducts([{ bumblebeeProductId: BB10, name: 'Linked' }], COMPANY);
    // An Auto-Stock product with no BumbleBee id.
    await getDb()
      .insert(products)
      .values({ companyId: COMPANY, name: 'Local only', slug: 'local-only-rec' });

    const rec = await svc.reconcile([BB10, BB99], COMPANY);
    expect(rec.unlinked.map((u) => u.name)).toContain('Local only');
    expect(rec.notStocked).toEqual([BB99]); // bb-10 is stocked, bb-99 isn't
  });
});
