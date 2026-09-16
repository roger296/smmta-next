/**
 * End to end for the invoice-OCR importer: an extract CSV in, supplier_products
 * and supplier_product_aliases out.
 *
 * The cases that matter are the refusals. Attaching a supplier's code, pack
 * size and price to the WRONG product is worse than leaving it unattached: the
 * mapping looks deliberate, and every reorder for both products is wrong
 * afterwards with nothing on screen saying so.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, supplierProductAliases, supplierProducts, suppliers } from '../src/db/schema/index.js';
import { resolveSupplierSku } from '../src/modules/suppliers/supplier-sku-resolver.js';
import { importInvoiceSkus } from './import-invoice-skus.js';

/** A throwaway company, NOT the singleton: `supplier_products` is shared state
 *  and vitest runs test files alongside each other, so writing under the real
 *  id would race the supplier-poll worker's fixtures. */
const COMPANY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PREFIX = 'INVSKU';
const HEADER =
  'supplier,supplier_sku,aliases,description,pack_size,unit_cost_gbp,lines_seen,last_seen,min_confidence';

let dir: string;
let flourId: string;
let butterId: string;
let brakesId: string;

function csvFile(...rows: string[]): string {
  const p = join(dir, `${Math.random().toString(36).slice(2)}.csv`);
  writeFileSync(p, [HEADER, ...rows].join('\n') + '\n');
  return p;
}

async function wipe() {
  const db = getDb();
  const ps = await db
    .select({ id: products.id })
    .from(products)
    .where(inArray(products.stockCode, [`${PREFIX}-FLOUR`, `${PREFIX}-BUTTER`, `${PREFIX}-DUP-A`, `${PREFIX}-DUP-B`]));
  for (const p of ps) {
    const sps = await db.select({ id: supplierProducts.id }).from(supplierProducts).where(eq(supplierProducts.productId, p.id));
    for (const sp of sps) {
      await db.delete(supplierProductAliases).where(eq(supplierProductAliases.supplierProductId, sp.id));
    }
    await db.delete(supplierProducts).where(eq(supplierProducts.productId, p.id));
    await db.delete(products).where(eq(products.id, p.id));
  }
  const ss = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.slug, `${PREFIX}-brakes`));
  for (const s of ss) {
    await db.delete(supplierProductAliases).where(eq(supplierProductAliases.supplierId, s.id));
    await db.delete(supplierProducts).where(eq(supplierProducts.supplierId, s.id));
    await db.delete(suppliers).where(eq(suppliers.id, s.id));
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'invsku-'));
});

afterAll(async () => {
  await wipe();
  await closeDatabase();
});

beforeEach(async () => {
  await wipe();
  const db = getDb();
  const [f] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Sysco Classic Self Raising Flour', stockCode: `${PREFIX}-FLOUR`, stockUom: 'kg' })
    .returning();
  flourId = f!.id;
  const [b] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Wholesome Farms Unsalted Butter', stockCode: `${PREFIX}-BUTTER`, stockUom: 'kg' })
    .returning();
  butterId = b!.id;
  const [s] = await db
    .insert(suppliers)
    .values({ companyId: COMPANY, name: 'Brakes', slug: `${PREFIX}-brakes` })
    .returning();
  brakesId = s!.id;
});

describe('importInvoiceSkus', () => {
  it('creates the mapping and its aliases, and all three spellings then resolve', async () => {
    const file = csvFile(
      'Brakes,33891,"A 33891, A33891",Sysco Classic Self Raising Flour,1 x 25kg,25.4,10,2026-04-08,0.90',
    );
    const r = await importInvoiceSkus({ file, companyId: COMPANY });
    expect(r.created).toBe(1);
    expect(r.aliasesAdded).toBe(2);
    expect(r.unmatched).toHaveLength(0);

    const db = getDb();
    const [sp] = await db.select().from(supplierProducts).where(eq(supplierProducts.productId, flourId));
    expect(sp!.supplierSku).toBe('33891');
    expect(Number(sp!.costGbp)).toBe(25.4);
    // Not read off the invoice text: `100x1` and `1x100` are the same shape
    // meaning opposite things. Reported as wanted instead.
    expect(sp!.supplierPackSize).toBeNull();
    expect(r.packSizeWanted).toEqual([
      { supplier: 'Brakes', sku: '33891', observedPack: '1 x 25kg', linesSeen: 10 },
    ]);

    // The whole point: every spelling finds the one mapping, and only the
    // canonical one is what you would quote back to Brakes.
    for (const spelling of ['33891', 'A 33891', 'A33891']) {
      const hit = await resolveSupplierSku(brakesId, spelling, COMPANY);
      expect(hit?.supplierProduct.id).toBe(sp!.id);
      expect(hit?.supplierProduct.supplierSku).toBe('33891');
    }
    expect((await resolveSupplierSku(brakesId, '33891', COMPANY))?.matchedVia).toBe('CANONICAL');
    expect((await resolveSupplierSku(brakesId, 'A33891', COMPANY))?.matchedVia).toBe('ALIAS');
  });

  it('is a no-op on --dry-run', async () => {
    const file = csvFile('Brakes,33891,"A33891",Sysco Classic Self Raising Flour,1 x 25kg,25.4,10,2026-04-08,0.90');
    const r = await importInvoiceSkus({ file, dryRun: true, companyId: COMPANY });
    expect(r.created).toBe(1);
    const db = getDb();
    expect(await db.select().from(supplierProducts).where(eq(supplierProducts.productId, flourId))).toHaveLength(0);
  });

  it('matches on stock code as well as on the description', async () => {
    const file = csvFile(
      `Brakes,${PREFIX}-BUTTER,,A Name The Venue Never Uses,40x250g,58.51,158,2026-09-11,0.70`,
    );
    const r = await importInvoiceSkus({ file, companyId: COMPANY });
    expect(r.created).toBe(1);
    const db = getDb();
    expect(await db.select().from(supplierProducts).where(eq(supplierProducts.productId, butterId))).toHaveLength(1);
  });

  /**
   * The refusal the header is about. "Unsalted Butter" is not "Wholesome Farms
   * Unsalted Butter" — a human knows, a similarity score guesses, and a wrong
   * guess is invisible once written.
   */
  it('reports a near-miss description as unmatched rather than guessing', async () => {
    const file = csvFile('Brakes,99001,,Unsalted Butter,1x2kg,6.56,12,2026-09-11,0.90');
    const r = await importInvoiceSkus({ file, companyId: COMPANY });
    expect(r.created).toBe(0);
    expect(r.unmatched).toEqual([
      { supplier: 'Brakes', sku: '99001', description: 'Unsalted Butter', linesSeen: 12 },
    ]);
  });

  it('ranks the unmatched work list by how often the code was billed', async () => {
    const file = csvFile(
      'Brakes,99001,,Rarely Bought Thing,1x1kg,1.00,2,2026-09-11,0.90',
      'Brakes,99002,,Constantly Bought Thing,1x1kg,1.00,158,2026-09-11,0.90',
    );
    const r = await importInvoiceSkus({ file, companyId: COMPANY });
    expect(r.unmatched.map((u) => u.sku)).toEqual(['99002', '99001']);
  });

  /**
   * A name shared by two live products identifies NEITHER. Resolving to
   * whichever row came back first would attach the code to an arbitrary one of
   * them, and the arbitrariness would not survive a re-run.
   */
  it('refuses an ambiguous name rather than picking one of the two', async () => {
    const db = getDb();
    for (const code of [`${PREFIX}-DUP-A`, `${PREFIX}-DUP-B`]) {
      await db.insert(products).values({ companyId: COMPANY, name: 'Twice Named Thing', stockCode: code, stockUom: 'kg' });
    }
    const file = csvFile('Brakes,99003,,Twice Named Thing,1x1kg,1.00,9,2026-09-11,0.90');
    const r = await importInvoiceSkus({ file, companyId: COMPANY });
    expect(r.created).toBe(0);
    expect(r.unmatched.map((u) => u.sku)).toEqual(['99003']);
  });

  it('names a supplier Auto-Stock has never heard of instead of inventing one', async () => {
    const file = csvFile('Nobody Ltd,55,,Sysco Classic Self Raising Flour,1x1kg,1.00,4,2026-09-11,0.90');
    const r = await importInvoiceSkus({ file, companyId: COMPANY });
    expect(r.unknownSupplier).toEqual([{ supplier: 'Nobody Ltd', codes: 1 }]);
    expect(r.created).toBe(0);
  });

  it('matches the supplier case-insensitively, as the invoices spell it', async () => {
    const file = csvFile('brakes,33891,,Sysco Classic Self Raising Flour,1x25kg,25.4,10,2026-04-08,0.90');
    expect((await importInvoiceSkus({ file, companyId: COMPANY })).created).toBe(1);
  });

  it('gap-fills a cost the mapping did not have', async () => {
    const db = getDb();
    await db.insert(supplierProducts).values({
      companyId: COMPANY, productId: flourId, supplierId: brakesId,
      supplierSku: '33891', costGbp: null, supplierPackSize: '1',
    });
    const file = csvFile('Brakes,33891,,Sysco Classic Self Raising Flour,1 x 25kg,25.4,10,2026-04-08,0.90');
    const r = await importInvoiceSkus({ file, companyId: COMPANY });
    expect(r).toMatchObject({ created: 0, gapFilled: 1 });
    const [sp] = await db.select().from(supplierProducts).where(eq(supplierProducts.productId, flourId));
    expect(Number(sp!.costGbp)).toBe(25.4);
  });

  /**
   * An operator who typed a price agreed with the supplier knows more than an
   * OCR'd invoice from four months ago.
   */
  it('never overwrites a cost somebody typed', async () => {
    const db = getDb();
    await db.insert(supplierProducts).values({
      companyId: COMPANY, productId: flourId, supplierId: brakesId,
      supplierSku: '33891', costGbp: '19.99', supplierPackSize: '1',
    });
    const file = csvFile('Brakes,33891,,Sysco Classic Self Raising Flour,1 x 25kg,25.4,10,2026-04-08,0.90');
    const r = await importInvoiceSkus({ file, companyId: COMPANY });
    expect(r).toMatchObject({ created: 0, gapFilled: 0, unchanged: 1 });
    const [sp] = await db.select().from(supplierProducts).where(eq(supplierProducts.productId, flourId));
    expect(Number(sp!.costGbp)).toBe(19.99);
  });

  it('reports nothing to change as unchanged', async () => {
    const db = getDb();
    await db.insert(supplierProducts).values({
      companyId: COMPANY, productId: flourId, supplierId: brakesId,
      supplierSku: '33891', costGbp: '19.99', supplierPackSize: '1',
    });
    const file = csvFile('Brakes,33891,,Sysco Classic Self Raising Flour,1 x 25kg,25.4,10,2026-04-08,0.90');
    const r = await importInvoiceSkus({ file, companyId: COMPANY });
    expect(r).toMatchObject({ created: 0, gapFilled: 0, unchanged: 1 });
    expect(r.packSizeWanted).toHaveLength(0);
  });

  /**
   * Uniqueness spans supplier_products AND supplier_product_aliases, and no
   * single index sees across both. An alias that is already another mapping's
   * canonical code is skipped and named, never merged.
   */
  it('skips an alias that is already another mapping s code, and says which', async () => {
    const file = csvFile(
      'Brakes,11127,,Wholesome Farms Unsalted Butter,40x250g,58.51,158,2026-09-11,0.70',
      'Brakes,33891,"11127",Sysco Classic Self Raising Flour,1 x 25kg,25.4,10,2026-04-08,0.90',
    );
    const r = await importInvoiceSkus({ file, companyId: COMPANY });
    expect(r.created).toBe(2);
    expect(r.aliasesAdded).toBe(0);
    expect(r.aliasConflicts).toHaveLength(1);
    expect(r.aliasConflicts[0]).toMatchObject({ supplier: 'Brakes', sku: '33891', alias: '11127' });
    // 11127 still resolves to the butter, as its own canonical code.
    const hit = await resolveSupplierSku(brakesId, '11127', COMPANY);
    expect(hit?.matchedVia).toBe('CANONICAL');
    expect(hit?.supplierProduct.productId).toBe(butterId);
  });

  it('drops an alias that merely repeats its own canonical code', async () => {
    const file = csvFile('Brakes,33891,"33891, A33891",Sysco Classic Self Raising Flour,1x25kg,25.4,10,2026-04-08,0.90');
    const r = await importInvoiceSkus({ file, companyId: COMPANY });
    expect(r.aliasesAdded).toBe(1);
  });

  it('leaves the cost null rather than writing 0.00 when the OCR found no price', async () => {
    const file = csvFile('Brakes,33891,,Sysco Classic Self Raising Flour,1x25kg,,10,2026-04-08,0.90');
    await importInvoiceSkus({ file, companyId: COMPANY });
    const db = getDb();
    const [sp] = await db.select().from(supplierProducts).where(eq(supplierProducts.productId, flourId));
    expect(sp!.costGbp).toBeNull();
  });
});
