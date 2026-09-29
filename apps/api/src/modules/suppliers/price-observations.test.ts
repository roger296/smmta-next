/**
 * Supplier price observations (supplier-ordering groundwork). Real Postgres,
 * isolated company.
 *
 * Covers: an invoice line whose code resolves to ONE buying option becomes a
 * price observation (canonical or alias spelling), with the venue and date;
 * everything it cannot attribute is counted, not guessed; a dry run writes
 * nothing; a re-run is a no-op; and "last paid" is the newest observation,
 * aged and flagged stale.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  products,
  sites,
  supplierPriceObservations,
  supplierProductAliases,
  supplierProducts,
  suppliers,
} from '../../db/schema/index.js';
import type { InvoiceLine } from './invoice-sku-extract.js';
import { backfillFromInvoices, latestPrices, STALE_PRICE_DAYS } from './price-observations.js';

const COMPANY = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
let flourMapping: string;
let sugarA: string;
let siteId: string;

const line = (over: Partial<InvoiceLine>): InvoiceLine => ({
  stock_item: 'Plain Flour 16kg',
  sku: '33891',
  supplier: 'PO Brakes',
  invoice_date: '2026-08-12',
  invoice_number: 'INV-1',
  pack_size: '1x16kg',
  quantity: 2,
  unit_price: 11.12,
  line_total: 22.24,
  confidence: 0.95,
  location: 'PO East',
  currency: 'GBP',
  ...over,
});

async function wipe(): Promise<void> {
  const db = getDb();
  await db.delete(supplierPriceObservations).where(eq(supplierPriceObservations.companyId, COMPANY));
}

beforeAll(async () => {
  const db = getDb();
  await wipe();
  // Mappings first: their supplier/product foreign keys do not cascade.
  await db.delete(supplierProducts).where(eq(supplierProducts.companyId, COMPANY));
  await db.delete(suppliers).where(eq(suppliers.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));

  const [brakes] = await db.insert(suppliers).values({ companyId: COMPANY, name: 'PO Brakes' }).returning();
  const [flour] = await db.insert(products).values({ companyId: COMPANY, name: 'PO Flour', slug: 'po-flour' }).returning();
  const [sugar1] = await db.insert(products).values({ companyId: COMPANY, name: 'PO Sugar 1', slug: 'po-sugar-1' }).returning();
  const [sugar2] = await db.insert(products).values({ companyId: COMPANY, name: 'PO Sugar 2', slug: 'po-sugar-2' }).returning();
  const [m] = await db
    .insert(supplierProducts)
    .values({ companyId: COMPANY, productId: flour!.id, supplierId: brakes!.id, supplierSku: '33891' })
    .returning();
  flourMapping = m!.id;
  await db.insert(supplierProductAliases).values({
    companyId: COMPANY,
    supplierProductId: flourMapping,
    supplierId: brakes!.id,
    aliasSku: 'A 33891',
  });
  // One code, two purchasable lines: a price cannot be attributed.
  const [a] = await db
    .insert(supplierProducts)
    .values({ companyId: COMPANY, productId: sugar1!.id, supplierId: brakes!.id, supplierSku: '5550' })
    .returning();
  sugarA = a!.id;
  await db
    .insert(supplierProducts)
    .values({ companyId: COMPANY, productId: sugar2!.id, supplierId: brakes!.id, supplierSku: '5550' });
  const [s] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'po-east', name: 'PO East', canonicalName: 'PO East' })
    .returning();
  siteId = s!.id;
});

beforeEach(wipe);

afterAll(async () => {
  const db = getDb();
  await wipe();
  // Mappings first: their supplier/product foreign keys do not cascade.
  await db.delete(supplierProducts).where(eq(supplierProducts.companyId, COMPANY));
  await db.delete(suppliers).where(eq(suppliers.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  await closeDatabase();
});

const observations = () =>
  getDb().select().from(supplierPriceObservations).where(eq(supplierPriceObservations.companyId, COMPANY));

describe('backfillFromInvoices', () => {
  it('prices a code that resolves to one buying option, with venue, date and invoice', async () => {
    const r = await backfillFromInvoices([line({})], { apply: true, companyId: COMPANY });
    expect(r).toMatchObject({ lines: 1, resolved: 1, inserted: 1 });
    const [o] = await observations();
    expect(o).toMatchObject({
      supplierProductId: flourMapping,
      source: 'INVOICE',
      unitPrice: '11.120000',
      siteId,
      documentRef: 'INV-1',
      packSeen: '1x16kg',
      quantity: '2.000',
    });
    expect(o!.observedAt.toISOString().slice(0, 10)).toBe('2026-08-12');
  });

  it('an alias spelling resolves to its canonical line', async () => {
    await backfillFromInvoices([line({ sku: 'a 33891' })], { apply: true, companyId: COMPANY });
    expect((await observations())[0]!.supplierProductId).toBe(flourMapping);
  });

  it('trusts the line total over an OCR unit price that disagrees, and says so', async () => {
    await backfillFromInvoices([line({ quantity: 3, unit_price: 32.94, line_total: 33.36 })], {
      apply: true,
      companyId: COMPANY,
    });
    const [o] = await observations();
    expect(Number(o!.unitPrice)).toBeCloseTo(11.12, 4);
    expect(o!.note).toMatch(/derived from line total/);
  });

  it('counts what it cannot attribute instead of guessing', async () => {
    const r = await backfillFromInvoices(
      [
        line({ sku: null }),
        line({ sku: '70412', stock_item: 'Mystery' }),
        line({ sku: '70412', stock_item: 'Mystery', invoice_number: 'INV-2' }),
        line({ sku: '5550' }),
        line({ supplier: 'Nobody Ltd' }),
        line({ unit_price: null, line_total: null }),
        line({ unit_price: -0.82, line_total: -0.98, quantity: 1 }),
        line({ invoice_date: null }),
      ],
      { apply: true, companyId: COMPANY },
    );
    expect(r.resolved).toBe(0);
    expect(r.skipped).toEqual({
      NO_CODE: 1,
      NO_PRICE: 1,
      NO_DATE: 1,
      CREDIT_OR_ZERO: 1,
      UNKNOWN_SUPPLIER: 1,
      CODE_NOT_MAPPED: 2,
      CODE_ON_SEVERAL_LINES: 1,
    });
    expect(r.unmappedCodes).toEqual([{ supplier: 'PO Brakes', sku: '70412', description: 'Mystery', lines: 2 }]);
    expect(r.ambiguousCodes).toEqual([{ supplier: 'PO Brakes', sku: '5550', mappings: 2 }]);
    expect(await observations()).toHaveLength(0);
    // Neither of the two sugar lines was given the price.
    expect((await latestPrices([sugarA])).size).toBe(0);
  });

  it('a dry run writes nothing', async () => {
    const r = await backfillFromInvoices([line({})], { apply: false, companyId: COMPANY });
    expect(r.resolved).toBe(1);
    expect(r.inserted).toBe(0);
    expect(await observations()).toHaveLength(0);
  });

  it('re-running on the same capture adds nothing', async () => {
    const lines = [line({}), line({ invoice_number: 'INV-2', invoice_date: '2026-09-01', unit_price: 11.8, line_total: 23.6 })];
    await backfillFromInvoices(lines, { apply: true, companyId: COMPANY });
    const again = await backfillFromInvoices(lines, { apply: true, companyId: COMPANY });
    expect(again).toMatchObject({ inserted: 0, alreadyRecorded: 2 });
    expect(await observations()).toHaveLength(2);
  });
});

describe('latestPrices', () => {
  it('is the newest observation, with its age and source', async () => {
    await backfillFromInvoices(
      [
        line({ invoice_number: 'OLD', invoice_date: '2026-05-01', unit_price: 10.5, line_total: 21 }),
        line({ invoice_number: 'NEW', invoice_date: '2026-09-01', unit_price: 11.8, line_total: 23.6 }),
      ],
      { apply: true, companyId: COMPANY },
    );
    const latest = (await latestPrices([flourMapping], new Date('2026-09-29T12:00:00Z'))).get(flourMapping)!;
    expect(latest).toMatchObject({ unitPrice: '11.800000', source: 'INVOICE', documentRef: 'NEW', ageDays: 28, stale: false });
  });

  it(`flags a price older than ${STALE_PRICE_DAYS} days as stale`, async () => {
    await backfillFromInvoices([line({ invoice_date: '2026-05-01' })], { apply: true, companyId: COMPANY });
    const latest = (await latestPrices([flourMapping], new Date('2026-09-29T12:00:00Z'))).get(flourMapping)!;
    expect(latest.stale).toBe(true);
    expect(latest.ageDays).toBe(151);
  });
});
