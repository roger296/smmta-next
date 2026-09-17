/**
 * End to end for the mapping repair, against a real database.
 *
 * The cases that matter are the ones where getting it wrong is invisible: a
 * soft-deleted row that keeps competing for a reorder, an alias that outlives
 * its mapping and blocks the surviving one, and a dry run that turns out to
 * have written something.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, supplierProductAliases, supplierProducts, suppliers } from '../src/db/schema/index.js';
import { resolveSupplierSku, aliasConflict } from '../src/modules/suppliers/supplier-sku-resolver.js';
import { preferredSupplierProduct } from '../src/modules/stock/supplier-products.js';
import { fixSupplierMappings } from './fix-supplier-mappings.js';

const COMPANY = 'dddddddd-dddd-4ddd-8ddd-ddddddddfacc';
const PREFIX = 'FIXMAP';

const SKU_HEADER =
  'supplier,supplier_sku,aliases,description,pack_size,unit_cost_gbp,lines_seen,last_seen,min_confidence';
const DEC_HEADER =
  'supplier,supplier_sku,description,pack_size,lines_seen,unit_cost_gbp,client_name,source,' +
  'proposed_product,proposed_stock_code,alternatives,decision,new_product_name,new_stock_uom';
const COR_HEADER = 'supplier,supplier_sku,stock_code,why';

let dir: string;
let butterId: string;
let sugarId: string;
let carrotId: string;
let brakesId: string;

const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
function file(header: string, rows: string[]): string {
  const p = join(dir, `${Math.random().toString(36).slice(2)}.csv`);
  writeFileSync(p, [header, ...rows].join('\n') + '\n');
  return p;
}
const skuRow = (sku: string, description: string, lines = 10, aliases = '') =>
  `Brakes,${sku},${q(aliases)},${q(description)},1 x 1kg,1.23,${lines},2026-04-08,0.90`;
const decRow = (sku: string, description: string, decision: string, proposed = '') =>
  ['Brakes', sku, q(description), '1 x 1kg', '7', '1.23', '', 'matched', '', proposed, '', q(decision), '""', ''].join(',');

async function wipe() {
  const db = getDb();
  const ps = await db.select({ id: products.id }).from(products).where(eq(products.companyId, COMPANY));
  for (const p of ps) {
    const sps = await db.select({ id: supplierProducts.id }).from(supplierProducts)
      .where(eq(supplierProducts.productId, p.id));
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

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'fixmap-')); });
afterAll(async () => { await wipe(); await closeDatabase(); });

beforeEach(async () => {
  await wipe();
  const db = getDb();
  const mk = async (name: string, code: string) => {
    const [p] = await db.insert(products).values({
      companyId: COMPANY, name, stockCode: code, slug: code.toLowerCase(), stockUom: 'kg',
    }).returning();
    return p!.id;
  };
  butterId = await mk('Unsalted Butter', `${PREFIX}-BUTTER`);
  sugarId = await mk('Caster Sugar', `${PREFIX}-SUGAR`);
  carrotId = await mk('Carrots', `${PREFIX}-CARROTS`);
  const [s] = await db.insert(suppliers).values({
    companyId: COMPANY, name: 'Brakes', slug: `${PREFIX}-brakes`,
  }).returning();
  brakesId = s!.id;
});

const run = (o: { apply?: boolean; skus: string[]; decisions?: string[]; corrections?: string[] }) =>
  fixSupplierMappings({
    apply: o.apply,
    companyId: COMPANY,
    skusFile: file(SKU_HEADER, o.skus),
    decisionsFile: file(DEC_HEADER, o.decisions ?? []),
    correctionsFile: file(COR_HEADER, o.corrections ?? []),
  });

describe('fixSupplierMappings - delete surplus', () => {
  beforeEach(async () => {
    // The real Brakes 11127: the wrong row on Caster Sugar beside the right
    // one, spelled `C 11127`, on Unsalted Butter.
    const db = getDb();
    await db.insert(supplierProducts).values([
      { companyId: COMPANY, productId: sugarId, supplierId: brakesId, supplierSku: '11127' },
      { companyId: COMPANY, productId: butterId, supplierId: brakesId, supplierSku: 'C 11127' },
    ]);
  });

  it('soft-deletes the wrong row and leaves the right one', async () => {
    const r = await run({ apply: true, skus: [skuRow('11127', 'Wholesome Farms Unsalted Butter', 158)] });
    expect(r.deleted).toBe(1);
    expect(r.repointed).toBe(0);

    const db = getDb();
    const live = await db.select().from(supplierProducts).where(
      and(eq(supplierProducts.supplierId, brakesId), isNull(supplierProducts.deletedAt)),
    );
    expect(live).toHaveLength(1);
    expect(live[0]!.productId).toBe(butterId);
  });

  it('stops the deleted row competing for a reorder', async () => {
    await run({ apply: true, skus: [skuRow('11127', 'Wholesome Farms Unsalted Butter', 158)] });
    // The whole point: `supplier_products` rows are buying options, and the
    // reorder engine ranks them. A row that still shows up here would still
    // be able to win an order for the wrong goods.
    expect(await preferredSupplierProduct(sugarId, COMPANY)).toBeNull();
    // ...while the correct product still has its buying option.
    const kept = await preferredSupplierProduct(butterId, COMPANY);
    expect(kept?.supplierSku).toBe('C 11127');
  });

  it('retires the deleted row\'s aliases so they stop blocking the survivor', async () => {
    const db = getDb();
    const [wrong] = await db.select().from(supplierProducts).where(
      and(eq(supplierProducts.supplierId, brakesId), eq(supplierProducts.supplierSku, '11127')),
    );
    await db.insert(supplierProductAliases).values({
      companyId: COMPANY, supplierProductId: wrong!.id, supplierId: brakesId,
      aliasSku: 'A11127', source: 'INVOICE_OCR',
    });

    const r = await run({ apply: true, skus: [skuRow('11127', 'Wholesome Farms Unsalted Butter', 158)] });
    expect(r.aliasesRetired).toBe(1);

    // `aliasConflict` does not check whether the owning mapping is deleted, so
    // a surviving alias row would refuse this spelling to the correct mapping
    // forever.
    const [survivor] = await db.select().from(supplierProducts).where(
      and(eq(supplierProducts.supplierId, brakesId), eq(supplierProducts.supplierSku, 'C 11127')),
    );
    expect(await aliasConflict(brakesId, 'A11127', survivor!.id, COMPANY)).toBeNull();
    // And it must stop resolving to the dead row.
    expect(await resolveSupplierSku(brakesId, 'A11127', COMPANY)).toBeNull();
  });

  it('writes nothing on a dry run', async () => {
    const r = await run({ skus: [skuRow('11127', 'Wholesome Farms Unsalted Butter', 158)] });
    expect(r.dryRun).toBe(true);
    expect(r.deletes).toHaveLength(1);

    const db = getDb();
    const live = await db.select().from(supplierProducts).where(
      and(eq(supplierProducts.supplierId, brakesId), isNull(supplierProducts.deletedAt)),
    );
    expect(live).toHaveLength(2);
  });
});

describe('fixSupplierMappings - repoint', () => {
  it('moves the code to the product the decisions sheet named', async () => {
    const db = getDb();
    await db.insert(supplierProducts).values({
      companyId: COMPANY, productId: sugarId, supplierId: brakesId, supplierSku: '10230',
    });
    // The sheet's target has to agree with the invoice too - a first draft of
    // this test aimed a "Cucumber Single BB" line at Carrots and was refused,
    // which is the planner doing its job.
    const r = await run({
      apply: true,
      skus: [skuRow('10230', 'Prepared Baton Carrots', 76)],
      decisions: [decRow('10230', 'Prepared Baton Carrots', 'Y', `${PREFIX}-CARROTS`)],
    });
    expect(r.repointed).toBe(1);
    const [row] = await db.select().from(supplierProducts)
      .where(eq(supplierProducts.supplierSku, '10230'));
    expect(row!.productId).toBe(carrotId);
    expect(row!.deletedAt).toBeNull();
  });

  it('prefers the corrections file over the sheet', async () => {
    // The real Brakes 10417: the sheet said Popcorn for "Prepared Baton
    // Carrots"; a human confirmed Carrots.
    const db = getDb();
    await db.insert(supplierProducts).values({
      companyId: COMPANY, productId: sugarId, supplierId: brakesId, supplierSku: '10417',
    });
    const r = await run({
      apply: true,
      skus: [skuRow('10417', 'Prepared Baton Carrots', 7)],
      decisions: [decRow('10417', 'Prepared Baton Carrots', `${PREFIX}-BUTTER`)],
      corrections: [`Brakes,10417,${PREFIX}-CARROTS,confirmed by hand`],
    });
    expect(r.repointed).toBe(1);
    expect(r.repoints[0]!.source).toBe('correction');
    const [row] = await db.select().from(supplierProducts)
      .where(eq(supplierProducts.supplierSku, '10417'));
    expect(row!.productId).toBe(carrotId);
  });
});

describe('fixSupplierMappings - what it refuses', () => {
  it('refuses when nothing names a target, and writes nothing', async () => {
    const db = getDb();
    await db.insert(supplierProducts).values({
      companyId: COMPANY, productId: sugarId, supplierId: brakesId, supplierSku: '99999',
    });
    const r = await run({ apply: true, skus: [skuRow('99999', 'Something Else Entirely', 5)] });
    expect(r.deleted).toBe(0);
    expect(r.repointed).toBe(0);
    expect(r.refusals).toHaveLength(1);
    const [row] = await db.select().from(supplierProducts).where(eq(supplierProducts.supplierSku, '99999'));
    expect(row!.productId).toBe(sugarId);
    expect(row!.deletedAt).toBeNull();
  });

  it('leaves NOSKU rows alone', async () => {
    const db = getDb();
    await db.insert(supplierProducts).values([
      { companyId: COMPANY, productId: sugarId, supplierId: brakesId, supplierSku: 'NOSKU' },
      { companyId: COMPANY, productId: butterId, supplierId: brakesId, supplierSku: 'NOSKU' },
    ]);
    const r = await run({ apply: true, skus: [skuRow('NOSKU', 'Wholesome Farms Unsalted Butter', 20)] });
    expect(r.deleted).toBe(0);
    const live = await db.select().from(supplierProducts).where(
      and(eq(supplierProducts.supplierId, brakesId), isNull(supplierProducts.deletedAt)),
    );
    expect(live).toHaveLength(2);
  });

  it('does nothing at all when every mapping agrees with the invoices', async () => {
    const db = getDb();
    await db.insert(supplierProducts).values({
      companyId: COMPANY, productId: butterId, supplierId: brakesId, supplierSku: '11127',
    });
    const r = await run({ apply: true, skus: [skuRow('11127', 'Wholesome Farms Unsalted Butter', 158)] });
    expect(r.deleted).toBe(0);
    expect(r.repointed).toBe(0);
    expect(r.refusals).toEqual([]);
  });

  it('is idempotent - a second run finds nothing left to do', async () => {
    const db = getDb();
    await db.insert(supplierProducts).values([
      { companyId: COMPANY, productId: sugarId, supplierId: brakesId, supplierSku: '11127' },
      { companyId: COMPANY, productId: butterId, supplierId: brakesId, supplierSku: 'C 11127' },
    ]);
    const skus = [skuRow('11127', 'Wholesome Farms Unsalted Butter', 158)];
    expect((await run({ apply: true, skus })).deleted).toBe(1);
    const second = await run({ apply: true, skus });
    expect(second.deleted).toBe(0);
    expect(second.refusals).toEqual([]);
  });
});
