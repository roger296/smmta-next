/**
 * End to end for the reviewed-decisions mode: a match-review sheet in,
 * supplier codes AND the products they needed out.
 *
 * The cases that matter are the ones where honouring the sheet literally would
 * damage the catalogue - a second product with an existing product's name, a
 * product called "UNKNOWN", one product created per row when two rows name the
 * same thing. Those are the reasons this mode exists rather than a loop that
 * trusts the column.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, like } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, supplierProductAliases, supplierProducts, suppliers } from '../src/db/schema/index.js';
import { resolveSupplierSku } from '../src/modules/suppliers/supplier-sku-resolver.js';
import { importInvoiceSkuDecisions } from './import-invoice-skus.js';

/** A throwaway company, NOT the singleton - `supplier_products` is shared
 *  state and vitest runs test files alongside each other. */
const COMPANY = 'dddddddd-dddd-4ddd-8ddd-dddddddddece';
const PREFIX = 'INVDEC';

const SKU_HEADER =
  'supplier,supplier_sku,aliases,description,pack_size,unit_cost_gbp,lines_seen,last_seen,min_confidence';
const DEC_HEADER =
  'supplier,supplier_sku,description,pack_size,lines_seen,unit_cost_gbp,client_name,source,' +
  'proposed_product,proposed_stock_code,alternatives,decision,new_product_name,new_stock_uom';

let dir: string;
let flourId: string;
let cheeseId: string;
let brakesId: string;

/** CSV quoting, which is NOT JSON quoting: an embedded double quote is
 *  DOUBLED, not backslash-escaped. Using JSON.stringify here made the
 *  placeholder fixture (`UNKNOWN - "4 x 2.5kg"`) unparseable. */
function q(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

function file(header: string, rows: string[]): string {
  const p = join(dir, `${Math.random().toString(36).slice(2)}.csv`);
  writeFileSync(p, [header, ...rows].join('\n') + '\n');
  return p;
}

/** One decision row, with the columns the mode reads spelled out. */
function dec(o: {
  sku: string; description: string; decision: string;
  proposed?: string; newName?: string; newUom?: string;
}): string {
  return [
    'Brakes', o.sku, q(o.description), '1 x 1kg', '7', '1.23', '', 'matched',
    '', o.proposed ?? '', '', q(o.decision), q(o.newName ?? ''), o.newUom ?? '',
  ].join(',');
}

function sku(o: { sku: string; description: string; aliases?: string }): string {
  return `Brakes,${o.sku},${q(o.aliases ?? '')},${q(o.description)},1 x 1kg,1.23,7,2026-04-08,0.90`;
}

async function wipe() {
  const db = getDb();
  const ps = await db.select({ id: products.id }).from(products).where(eq(products.companyId, COMPANY));
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

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'invdec-')); });
afterAll(async () => { await wipe(); await closeDatabase(); });

beforeEach(async () => {
  await wipe();
  const db = getDb();
  const [f] = await db.insert(products).values({
    companyId: COMPANY, name: 'Self-Raising Flour', stockCode: `${PREFIX}-FLOUR`,
    slug: `${PREFIX}-flour`.toLowerCase(), stockUom: 'kg',
  }).returning();
  flourId = f!.id;
  const [c] = await db.insert(products).values({
    companyId: COMPANY, name: 'Cheese (unspecified)', stockCode: `${PREFIX}-CHEESE`,
    slug: `${PREFIX}-cheese`.toLowerCase(), stockUom: 'kg',
  }).returning();
  cheeseId = c!.id;
  const [s] = await db.insert(suppliers).values({
    companyId: COMPANY, name: 'Brakes', slug: `${PREFIX}-brakes`,
  }).returning();
  brakesId = s!.id;
});

async function run(decRows: string[], skuRows: string[], dryRun = false) {
  return importInvoiceSkuDecisions({
    decisionsFile: file(DEC_HEADER, decRows),
    skusFile: file(SKU_HEADER, skuRows),
    companyId: COMPANY,
    dryRun,
  });
}

describe('importInvoiceSkuDecisions', () => {
  it('places a "Y" against the proposed product, aliases and all', async () => {
    const r = await run(
      [dec({ sku: '33891', description: 'Sysco Classic Self Raising Flour', decision: 'Y', proposed: `${PREFIX}-FLOUR` })],
      [sku({ sku: '33891', description: 'Sysco Classic Self Raising Flour', aliases: 'A 33891, A33891' })],
    );
    expect(r.refusals).toEqual([]);
    expect(r.created).toBe(1);
    expect(r.aliasesAdded).toBe(2);

    const db = getDb();
    const [sp] = await db.select().from(supplierProducts).where(eq(supplierProducts.productId, flourId));
    expect(sp!.supplierSku).toBe('33891');
    // The aliases live in supplier-skus.csv, not in the sheet - the reviewer
    // judges the product, the extract supplies the evidence.
    expect((await resolveSupplierSku(brakesId, 'A33891', COMPANY))?.matchedVia).toBe('ALIAS');
  });

  it('lets a written-in stock code overrule the proposal', async () => {
    const r = await run(
      [dec({ sku: '1', description: 'x', decision: `${PREFIX}-CHEESE`, proposed: `${PREFIX}-FLOUR` })],
      [sku({ sku: '1', description: 'x' })],
    );
    expect(r.refusals).toEqual([]);
    const db = getDb();
    expect(await db.select().from(supplierProducts).where(eq(supplierProducts.productId, cheeseId))).toHaveLength(1);
    expect(await db.select().from(supplierProducts).where(eq(supplierProducts.productId, flourId))).toHaveLength(0);
  });

  it('creates the product an ADD ITEM asks for, and leaves it needing setup', async () => {
    const r = await run(
      [dec({ sku: '2', description: 'Sugar Crunch - Caramel', decision: 'ADD ITEM', newName: 'Sugar Crunch Caramel', newUom: 'kg' })],
      [sku({ sku: '2', description: 'Sugar Crunch - Caramel' })],
    );
    expect(r.refusals).toEqual([]);
    expect(r.productsCreated).toEqual([
      { name: 'Sugar Crunch Caramel', stockCode: 'SUGA-CRUN-CARA', stockUom: 'kg', codes: 1 },
    ]);

    const db = getDb();
    const [p] = await db.select().from(products)
      .where(and(eq(products.companyId, COMPANY), eq(products.stockCode, 'SUGA-CRUN-CARA')));
    expect(p!.stockUom).toBe('kg');
    expect(p!.isStocked).toBe(true);
    expect(p!.isSold).toBe(false);
    // The invoice price is per PACK. Writing it into expectedNextCost - which
    // is per purchase unit against a factor of 1 - would price this at the
    // pack price PER KILO in every recipe. It goes on the supplier line only.
    expect(Number(p!.expectedNextCost)).toBe(0);
    expect(p!.purchaseUom).toBeNull();
    const [sp] = await db.select().from(supplierProducts).where(eq(supplierProducts.productId, p!.id));
    expect(Number(sp!.costGbp)).toBe(1.23);
  });

  it('gives two rows naming one product ONE product carrying both codes', async () => {
    const r = await run(
      [
        dec({ sku: '6462', description: 'Confetti - Glimmer - Blossom', decision: 'ADD ITEM', newName: 'Confetti - Glimmer - Blossom', newUom: 'kg' }),
        dec({ sku: '6462-4kg', description: 'Confetti - Glimmer - Blossom', decision: 'ADD ITEM', newName: 'Confetti - Glimmer - Blossom', newUom: 'kg' }),
      ],
      [
        sku({ sku: '6462', description: 'Confetti - Glimmer - Blossom' }),
        sku({ sku: '6462-4kg', description: 'Confetti - Glimmer - Blossom' }),
      ],
    );
    expect(r.refusals).toEqual([]);
    expect(r.productsCreated).toHaveLength(1);
    const db = getDb();
    const [p] = await db.select().from(products)
      .where(and(eq(products.companyId, COMPANY), eq(products.stockCode, 'CONF-GLIM-BLOS')));
    const sps = await db.select().from(supplierProducts).where(eq(supplierProducts.productId, p!.id));
    expect(sps.map((s) => s.supplierSku).sort()).toEqual(['6462', '6462-4kg']);
  });

  it('attaches to an existing product of that name instead of creating a twin', async () => {
    const r = await run(
      [dec({ sku: '22053', description: 'Sysco Classc Mozz Shredded Cheese', decision: 'ADD ITEM', newName: 'Cheese (unspecified)', newUom: 'kg' })],
      [sku({ sku: '22053', description: 'Sysco Classc Mozz Shredded Cheese' })],
    );
    expect(r.productsCreated).toEqual([]);
    expect(r.adoptedExisting).toEqual([
      { supplier: 'Brakes', supplierSku: '22053', name: 'Cheese (unspecified)', stockCode: `${PREFIX}-CHEESE` },
    ]);
    const db = getDb();
    // The September merge existed because two products of one name split that
    // item's stock between them. Never again from here.
    expect(await db.select().from(products)
      .where(and(eq(products.companyId, COMPANY), like(products.name, 'Cheese%')))).toHaveLength(1);
    expect(await db.select().from(supplierProducts).where(eq(supplierProducts.productId, cheeseId))).toHaveLength(1);
  });

  it('refuses a placeholder name, writes the other rows, and says which it refused', async () => {
    const r = await run(
      [
        dec({ sku: 'ok', description: 'fine', decision: 'Y', proposed: `${PREFIX}-FLOUR` }),
        dec({ sku: 'bad', description: 'Sprinkletti - Party', decision: 'ADD ITEM', newName: 'UNKNOWN - "4 x 2.5kg" (check invoice)', newUom: 'kg' }),
      ],
      [sku({ sku: 'ok', description: 'fine' }), sku({ sku: 'bad', description: 'Sprinkletti - Party' })],
    );
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]!.reason).toContain('placeholder');
    // The answered row still lands: unanswered questions do not hold it back.
    expect(r.created).toBe(1);
    const db = getDb();
    expect(await db.select().from(supplierProducts).where(eq(supplierProducts.productId, flourId))).toHaveLength(1);
    expect(await db.select().from(products)
      .where(and(eq(products.companyId, COMPANY), like(products.name, 'UNKNOWN%')))).toHaveLength(0);
  });

  it('leaves a blank decision alone rather than guessing at it', async () => {
    const r = await run(
      [dec({ sku: '3', description: 'x', decision: '', proposed: `${PREFIX}-FLOUR` })],
      [sku({ sku: '3', description: 'x' })],
    );
    expect(r.undecided).toHaveLength(1);
    expect(r.created).toBe(0);
    expect(r.refusals).toEqual([]);
  });

  it('skips NOT STOCK without creating anything', async () => {
    const r = await run(
      [dec({ sku: 'DELIVERY', description: 'Courier Delivery', decision: 'NOT STOCK' })],
      [sku({ sku: 'DELIVERY', description: 'Courier Delivery' })],
    );
    expect(r.notStock).toBe(1);
    expect(r.created).toBe(0);
    expect(r.productsCreated).toEqual([]);
  });

  it('refuses a decision whose code is not in the extract, rather than inventing the evidence', async () => {
    const r = await run(
      [dec({ sku: 'ghost', description: 'x', decision: 'Y', proposed: `${PREFIX}-FLOUR` })],
      [sku({ sku: 'other', description: 'x' })],
    );
    expect(r.created).toBe(0);
    expect(r.refusals[0]!.reason).toContain('supplier-skus.csv');
  });

  it('writes nothing at all on --dry-run, products included', async () => {
    const rows = [
      dec({ sku: '2', description: 'Sugar Crunch - Caramel', decision: 'ADD ITEM', newName: 'Sugar Crunch Caramel', newUom: 'kg' }),
    ];
    const skus = [sku({ sku: '2', description: 'Sugar Crunch - Caramel' })];
    const r = await run(rows, skus, true);
    expect(r.productsCreated).toHaveLength(1);
    expect(r.created).toBe(1);

    const db = getDb();
    expect(await db.select().from(products)
      .where(and(eq(products.companyId, COMPANY), eq(products.stockCode, 'SUGA-CRUN-CARA')))).toHaveLength(0);
    expect(await db.select().from(supplierProducts).where(eq(supplierProducts.supplierId, brakesId))).toHaveLength(0);
  });

  it('is idempotent: a second run adds nothing', async () => {
    const rows = [
      dec({ sku: '33891', description: 'x', decision: 'Y', proposed: `${PREFIX}-FLOUR` }),
      dec({ sku: '2', description: 'y', decision: 'ADD ITEM', newName: 'Sugar Crunch Caramel', newUom: 'kg' }),
    ];
    const skus = [sku({ sku: '33891', description: 'x' }), sku({ sku: '2', description: 'y' })];
    const decFile = file(DEC_HEADER, rows);
    const skuFile = file(SKU_HEADER, skus);

    const first = await importInvoiceSkuDecisions({ decisionsFile: decFile, skusFile: skuFile, companyId: COMPANY });
    expect(first.created).toBe(2);
    expect(first.productsCreated).toHaveLength(1);

    const second = await importInvoiceSkuDecisions({ decisionsFile: decFile, skusFile: skuFile, companyId: COMPANY });
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(2);
    // The second run finds the product by name and attaches to it, rather than
    // minting SUGA-CRUN-CARA-2 beside the one it made a moment ago.
    expect(second.productsCreated).toEqual([]);
    expect(second.adoptedExisting).toHaveLength(1);

    const db = getDb();
    expect(await db.select().from(products)
      .where(and(eq(products.companyId, COMPANY), like(products.name, 'Sugar Crunch%')))).toHaveLength(1);
  });
});

describe('one code cannot mean two things', () => {
  it('skips a code this supplier already uses for a different product', async () => {
    const db = getDb();
    // Stand in for the July-2026 supplier-catalogue rows: the code is already
    // on Cheese, and the sheet now says it belongs to Flour.
    const [sp] = await db.insert(supplierProducts).values({
      companyId: COMPANY, productId: cheeseId, supplierId: brakesId, supplierSku: '149492',
    }).returning();

    const r = await importInvoiceSkuDecisions({
      decisionsFile: file(DEC_HEADER, [
        dec({ sku: '149492', description: 'Ariel Professional', decision: 'Y', proposed: `${PREFIX}-FLOUR` }),
      ]),
      skusFile: file(SKU_HEADER, [sku({ sku: '149492', description: 'Ariel Professional' })]),
      companyId: COMPANY,
    });

    expect(r.created).toBe(0);
    expect(r.skuOnOtherProduct).toEqual([{
      supplier: 'Brakes', sku: '149492', description: 'Ariel Professional',
      currentProduct: 'Cheese (unspecified)', currentStockCode: `${PREFIX}-CHEESE`,
    }]);
    // The reorder engine ranks purchasable lines against each other, so a
    // second row for this code could win the order. There must still be one.
    const rows = await db.select().from(supplierProducts)
      .where(and(eq(supplierProducts.supplierId, brakesId), eq(supplierProducts.supplierSku, '149492')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(sp!.id);
  });

  it('compares codes case- and space-insensitively, the way the resolver does', async () => {
    const db = getDb();
    await db.insert(supplierProducts).values({
      companyId: COMPANY, productId: cheeseId, supplierId: brakesId, supplierSku: ' A149492 ',
    });
    const r = await importInvoiceSkuDecisions({
      decisionsFile: file(DEC_HEADER, [
        dec({ sku: 'a149492', description: 'x', decision: 'Y', proposed: `${PREFIX}-FLOUR` }),
      ]),
      skusFile: file(SKU_HEADER, [sku({ sku: 'a149492', description: 'x' })]),
      companyId: COMPANY,
    });
    expect(r.created).toBe(0);
    expect(r.skuOnOtherProduct).toHaveLength(1);
  });

  it('still updates the code on the product it is ALREADY against', async () => {
    const db = getDb();
    await db.insert(supplierProducts).values({
      companyId: COMPANY, productId: flourId, supplierId: brakesId, supplierSku: '149492', costGbp: null,
    });
    const r = await importInvoiceSkuDecisions({
      decisionsFile: file(DEC_HEADER, [
        dec({ sku: '149492', description: 'x', decision: 'Y', proposed: `${PREFIX}-FLOUR` }),
      ]),
      skusFile: file(SKU_HEADER, [sku({ sku: '149492', description: 'x' })]),
      companyId: COMPANY,
    });
    expect(r.skuOnOtherProduct).toEqual([]);
    expect(r.gapFilled).toBe(1);
  });
});

describe('re-running is safe', () => {
  it('does not re-add aliases it already wrote, which the unique index would reject', async () => {
    const decFile = file(DEC_HEADER, [
      dec({ sku: '33891', description: 'x', decision: 'Y', proposed: `${PREFIX}-FLOUR` }),
    ]);
    const skuFile = file(SKU_HEADER, [
      sku({ sku: '33891', description: 'x', aliases: 'A 33891, A33891' }),
    ]);
    const opts = { decisionsFile: decFile, skusFile: skuFile, companyId: COMPANY };

    const first = await importInvoiceSkuDecisions(opts);
    expect(first.aliasesAdded).toBe(2);

    // Before the fix this threw on
    // supplier_product_aliases_supplier_sku_unq, halfway through a run that
    // had already written other rows.
    const second = await importInvoiceSkuDecisions(opts);
    expect(second.aliasesAdded).toBe(0);
    expect(second.aliasConflicts).toEqual([]);

    const db = getDb();
    const [sp] = await db.select().from(supplierProducts)
      .where(and(eq(supplierProducts.supplierId, brakesId), eq(supplierProducts.supplierSku, '33891')));
    expect(await db.select().from(supplierProductAliases)
      .where(eq(supplierProductAliases.supplierProductId, sp!.id))).toHaveLength(2);
  });

  it('matches an existing alias case- and space-insensitively', async () => {
    const skuFile = file(SKU_HEADER, [sku({ sku: '33891', description: 'x', aliases: 'A 33891' })]);
    const decRow = [dec({ sku: '33891', description: 'x', decision: 'Y', proposed: `${PREFIX}-FLOUR` })];
    await importInvoiceSkuDecisions({
      decisionsFile: file(DEC_HEADER, decRow), skusFile: skuFile, companyId: COMPANY,
    });
    // Same alias, differently cased, as a later invoice would spell it.
    const r = await importInvoiceSkuDecisions({
      decisionsFile: file(DEC_HEADER, decRow),
      skusFile: file(SKU_HEADER, [sku({ sku: '33891', description: 'x', aliases: ' a 33891 ' })]),
      companyId: COMPANY,
    });
    expect(r.aliasesAdded).toBe(0);
  });
});
