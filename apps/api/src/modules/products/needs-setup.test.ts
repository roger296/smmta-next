/**
 * Cost precision + the "needs setup" report (Aug-2026, C-1/C-2/C-4).
 *
 * "Icing sugar displayed an incorrect default unit quantity of 1kg."
 * "Skittles displayed an incorrect base unit, preventing the 1.6kg bags from
 *  being added."
 *
 * Both are the same DATA fault: seeded with `stockUom: 'g'`, `purchaseUom`
 * NULL and `purchaseToStockFactor` '1'. Nothing in the app said a word — a
 * product with no purchase model is indistinguishable from one bought in
 * single grams.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { products } from '../../db/schema/index.js';
import { NeedsSetupService, setupIssuesFor } from './needs-setup.service.js';

const COMPANY = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4';
const svc = new NeedsSetupService();
const slugs = ['ns-icing', 'ns-skittles', 'ns-ready', 'ns-boxes', 'ns-nopack'];

beforeAll(async () => {
  const db = getDb();
  await db.delete(products).where(eq(products.companyId, COMPANY));

  await db.insert(products).values([
    // The 12 Aug icing sugar, exactly as seeded: grams, no purchase unit,
    // factor 1, no cost.
    {
      companyId: COMPANY,
      name: 'NS Icing sugar',
      slug: 'ns-icing',
      itemKind: 'INGREDIENT',
      stockUom: 'g',
      purchaseToStockFactor: '1',
      expectedNextCost: '0',
    },
    // The Skittles: a purchase unit but the factor was never set.
    {
      companyId: COMPANY,
      name: 'NS Skittles',
      slug: 'ns-skittles',
      itemKind: 'INGREDIENT',
      stockUom: 'g',
      purchaseUom: 'bag',
      purchaseToStockFactor: '1',
      packDescription: '1.6 kg bag',
      expectedNextCost: '4.500000',
    },
    // Fully configured — must NOT appear.
    {
      companyId: COMPANY,
      name: 'NS Ready flour',
      slug: 'ns-ready',
      itemKind: 'INGREDIENT',
      stockUom: 'g',
      purchaseUom: 'sack',
      purchaseToStockFactor: '25000',
      packDescription: '25 kg sack',
      expectedNextCost: '0.001200',
    },
    // Discrete: bought and stocked in `each`, factor 1 is correct. Must NOT
    // be flagged for the factor — only for its missing cost.
    {
      companyId: COMPANY,
      name: 'NS Boxes',
      slug: 'ns-boxes',
      itemKind: 'PACKAGING',
      stockUom: 'each',
      purchaseToStockFactor: '1',
      expectedNextCost: '0',
    },
    // Configured except for the human-readable pack.
    {
      companyId: COMPANY,
      name: 'NS No pack text',
      slug: 'ns-nopack',
      itemKind: 'INGREDIENT',
      stockUom: 'ml',
      purchaseUom: 'drum',
      purchaseToStockFactor: '20000',
      expectedNextCost: '0.000900',
    },
  ]);
});

afterAll(async () => {
  const db = getDb();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await closeDatabase();
});

describe('C-4: cost precision survives the round trip', () => {
  it('a £0.0012/g price stores and reads back at 6dp, not 0.00', async () => {
    const row = await getDb().query.products.findFirst({
      where: eq(products.slug, 'ns-ready'),
    });
    // Under numeric(18,2) this was 0.00, and every line value computed from it
    // was zero — which is the "£0.00" the tester saw.
    expect(Number(row!.expectedNextCost)).toBeCloseTo(0.0012, 6);
    expect(Number(row!.expectedNextCost)).toBeGreaterThan(0);
  });

  it('an ordinary two-decimal price is unchanged by the widening', async () => {
    const row = await getDb().query.products.findFirst({
      where: eq(products.slug, 'ns-skittles'),
    });
    expect(Number(row!.expectedNextCost)).toBe(4.5);
  });
});

describe('setupIssuesFor — the rules, directly', () => {
  it('C-1: flags a fungible product with no purchase unit', () => {
    const issues = setupIssuesFor({
      stockUom: 'g',
      purchaseUom: null,
      purchaseToStockFactor: '1',
      packDescription: null,
      expectedNextCost: '1',
    });
    expect(issues.map((i) => i.kind)).toContain('NO_PURCHASE_UOM');
    expect(issues.find((i) => i.kind === 'NO_PURCHASE_UOM')!.message).toMatch(/= 1 g/);
  });

  it('C-2: flags a 1:1 factor on a fungible product', () => {
    const issues = setupIssuesFor({
      stockUom: 'g',
      purchaseUom: 'bag',
      purchaseToStockFactor: '1',
      packDescription: '1.6 kg bag',
      expectedNextCost: '4.5',
    });
    expect(issues.map((i) => i.kind)).toEqual(['FACTOR_IS_ONE']);
  });

  it('does NOT flag a 1:1 factor on a discrete product — that is correct', () => {
    const issues = setupIssuesFor({
      stockUom: 'each',
      purchaseUom: null,
      purchaseToStockFactor: '1',
      packDescription: null,
      expectedNextCost: '0.30',
    });
    expect(issues).toEqual([]);
  });

  it('C-4: flags a zero cost', () => {
    const issues = setupIssuesFor({
      stockUom: 'g',
      purchaseUom: 'sack',
      purchaseToStockFactor: '25000',
      packDescription: '25 kg sack',
      expectedNextCost: '0',
    });
    expect(issues.map((i) => i.kind)).toEqual(['NO_COST']);
  });

  it('flags a missing pack description only when a purchase unit exists', () => {
    const withUom = setupIssuesFor({
      stockUom: 'ml',
      purchaseUom: 'drum',
      purchaseToStockFactor: '20000',
      packDescription: null,
      expectedNextCost: '0.0009',
    });
    expect(withUom.map((i) => i.kind)).toEqual(['NO_PACK_DESCRIPTION']);
  });

  it('says nothing about a fully configured product', () => {
    expect(
      setupIssuesFor({
        stockUom: 'g',
        purchaseUom: 'sack',
        purchaseToStockFactor: '25000',
        packDescription: '25 kg sack',
        expectedNextCost: '0.0012',
      }),
    ).toEqual([]);
  });
});

describe('NeedsSetupService.list', () => {
  it('finds exactly the mis-configured fixtures, and not the ready one', async () => {
    const rows = await svc.list(COMPANY);
    const names = rows.map((r) => r.name);

    expect(names).toContain('NS Icing sugar');
    expect(names).toContain('NS Skittles');
    expect(names).toContain('NS Boxes');
    expect(names).toContain('NS No pack text');
    // The one product a venue could actually receive correctly.
    expect(names).not.toContain('NS Ready flour');
  });

  it('names what is wrong with each', async () => {
    const rows = await svc.list(COMPANY);
    const icing = rows.find((r) => r.name === 'NS Icing sugar')!;
    expect(icing.issues.map((i) => i.kind).sort()).toEqual([
      'FACTOR_IS_ONE',
      'NO_COST',
      'NO_PURCHASE_UOM',
    ]);

    const boxes = rows.find((r) => r.name === 'NS Boxes')!;
    // Discrete: only the cost, never the factor.
    expect(boxes.issues.map((i) => i.kind)).toEqual(['NO_COST']);
  });

  it('puts the worst first, so the list is worked in the right order', async () => {
    const rows = await svc.list(COMPANY);
    expect(rows[0]!.name).toBe('NS Icing sugar'); // three issues
    expect(rows[0]!.issues.length).toBeGreaterThanOrEqual(rows[1]!.issues.length);
  });

  it('summarises by issue kind', async () => {
    const summary = await svc.summary(COMPANY);
    expect(summary.total).toBe(4);
    expect(summary.byIssue.NO_PURCHASE_UOM).toBe(1);
    expect(summary.byIssue.NO_COST).toBe(2);
    expect(summary.byIssue.FACTOR_IS_ONE).toBe(2);
    expect(summary.byIssue.NO_PACK_DESCRIPTION).toBe(1);
  });
});

describe('cleanup guard', () => {
  it('the fixtures are the only rows this suite touched', async () => {
    const rows = await getDb()
      .select({ slug: products.slug })
      .from(products)
      .where(inArray(products.slug, slugs));
    expect(rows).toHaveLength(slugs.length);
  });
});
