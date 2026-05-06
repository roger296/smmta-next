/**
 * Integration tests for the seed:storefront script.
 *
 * Hits a real Postgres at DATABASE_URL (the docker-compose instance by
 * default). Mutates only the Storefront Demo company's rows, identified by
 * a fixed companyId. Uses an in-test fixture (`FIXTURE_ROWS`) to bypass
 * xlsx reading entirely, so the test doesn't depend on a particular
 * .tmp-catalogue.xlsx being present.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, productGroups, stockItems } from '../src/db/schema/index.js';
import {
  STOREFRONT_DEMO_COMPANY_ID,
  seedStorefront,
  parseSku,
  groupName,
  groupSlug,
  type CatalogueRow,
} from './seed-storefront.js';

afterAll(async () => {
  await closeDatabase();
});

/**
 * Six rows across three groups (PLA Basic, PLA+/Pro, PETG Regular). Mix of
 * in-stock and zero-stock to exercise both code paths.
 */
const FIXTURE_ROWS: CatalogueRow[] = [
  {
    stockCode: 'V3-PLA-BAS-BLACK',
    manufacturer: 'Landau',
    fullyQualifiedName: '1Kg Roll of FDM Printer Filament BLACK PLA Basic',
    oldGroupId: 55118,
    description: '1Kg Roll of FDM Printer Filament',
    netWeight: 1,
    shippingWeight: 1.3,
    dimensionH: 19,
    dimensionW: 19,
    dimensionD: 7,
    measurementUnit: 'cm',
    sellingPrice: 6.0,
    expectedNextCost: 3.42,
    rawColour: 'BLACKPLA Basic',
    stockQty: 25,
    imageUrl: 'https://example.com/landau-pla-basic-black.png',
  },
  {
    stockCode: 'V3-PLA-BAS-WHITE',
    manufacturer: 'Landau',
    fullyQualifiedName: '1Kg Roll of FDM Printer Filament WHITE PLA Basic',
    oldGroupId: 55118,
    description: '1Kg Roll of FDM Printer Filament',
    netWeight: 1,
    shippingWeight: 1.3,
    dimensionH: 19,
    dimensionW: 19,
    dimensionD: 7,
    measurementUnit: 'cm',
    sellingPrice: 6.0,
    expectedNextCost: 3.42,
    rawColour: 'WHITEPLA Basic',
    stockQty: 0, // zero stock — should still create the product
    imageUrl: 'https://example.com/landau-pla-basic-white.png',
  },
  {
    stockCode: 'V3-PLA-PRO-BLUE',
    manufacturer: 'Landau',
    fullyQualifiedName: '1Kg Roll of FDM Printer Filament BLUE PLA+/ Pro',
    oldGroupId: 55118,
    description: '1Kg Roll of FDM Printer Filament',
    netWeight: 1,
    shippingWeight: 1.3,
    dimensionH: 19,
    dimensionW: 19,
    dimensionD: 7,
    measurementUnit: 'cm',
    sellingPrice: 10.0,
    expectedNextCost: 5.0,
    rawColour: 'BLUEPLA+/ Pro',
    stockQty: 12,
    imageUrl: 'https://example.com/landau-pla-pro-blue.png',
  },
  {
    stockCode: 'V3-PLA-PRO-WHITE',
    manufacturer: 'Landau',
    fullyQualifiedName: '1Kg Roll of FDM Printer Filament WHITE PLA+/ Pro',
    oldGroupId: 55118,
    description: '1Kg Roll of FDM Printer Filament',
    netWeight: 1,
    shippingWeight: 1.3,
    dimensionH: 19,
    dimensionW: 19,
    dimensionD: 7,
    measurementUnit: 'cm',
    sellingPrice: 10.0,
    expectedNextCost: 5.0,
    rawColour: 'WHITEPLA+/ Pro',
    stockQty: 8,
    imageUrl: 'https://example.com/landau-pla-pro-white.png',
  },
  {
    stockCode: 'V3-PETG-REG-RED',
    manufacturer: 'Landau',
    fullyQualifiedName: '1Kg Roll of FDM Printer Filament RED PETG regular',
    oldGroupId: 55118,
    description: '1Kg Roll of FDM Printer Filament',
    netWeight: 1,
    shippingWeight: 1.3,
    dimensionH: 19,
    dimensionW: 19,
    dimensionD: 7,
    measurementUnit: 'cm',
    sellingPrice: 7.7,
    expectedNextCost: 3.85,
    rawColour: 'REDPETG regular',
    stockQty: 5,
    imageUrl: 'https://example.com/landau-petg-reg-red.png',
  },
  {
    stockCode: 'V3-PETG-REG-GREEN',
    manufacturer: 'Landau',
    fullyQualifiedName: '1Kg Roll of FDM Printer Filament GREEN PETG regular',
    oldGroupId: 55118,
    description: '1Kg Roll of FDM Printer Filament',
    netWeight: 1,
    shippingWeight: 1.3,
    dimensionH: 19,
    dimensionW: 19,
    dimensionD: 7,
    measurementUnit: 'cm',
    sellingPrice: 7.7,
    expectedNextCost: 3.85,
    rawColour: 'GREENPETG regular',
    stockQty: 3,
    imageUrl: 'https://example.com/landau-petg-reg-green.png',
  },
];

/** Total stock_items rows expected from the fixture: sum of stockQty values. */
const FIXTURE_EXPECTED_STOCK_ROWS = FIXTURE_ROWS.reduce((sum, r) => sum + r.stockQty, 0);
/** SKUs with stock > 0 — for the per-product stock count test. */
const FIXTURE_IN_STOCK_SKUS = FIXTURE_ROWS.filter((r) => r.stockQty > 0).map(
  (r) => r.stockCode,
);

describe('parseSku()', () => {
  it('parses standard 4-part SKUs (V3-MAT-SUB-COLOUR)', () => {
    expect(parseSku('V3-PLA-BAS-BLACK')).toEqual({
      material: 'PLA',
      subtype: 'BAS',
      colourSku: 'BLACK',
    });
    expect(parseSku('V3-PETG-PRO-BLUE')).toEqual({
      material: 'PETG',
      subtype: 'PRO',
      colourSku: 'BLUE',
    });
  });

  it('parses 3-part SKUs without sub-type (V3-MAT-COLOUR)', () => {
    expect(parseSku('V3-ABS-BLACK')).toEqual({
      material: 'ABS',
      subtype: '',
      colourSku: 'BLACK',
    });
  });

  it('parses multi-word colours (V3-PLA-BAS-FIRE ENGINE RED)', () => {
    expect(parseSku('V3-PLA-BAS-FIRE ENGINE RED')).toEqual({
      material: 'PLA',
      subtype: 'BAS',
      colourSku: 'FIRE ENGINE RED',
    });
  });

  it('strips trailing digits used as alternate-variant markers', () => {
    expect(parseSku('V3-PETG-REG-BLACK1')?.colourSku).toBe('BLACK');
    expect(parseSku('V3-ASA-BLACK2')?.colourSku).toBe('BLACK');
  });

  it('returns null for unparseable SKUs', () => {
    expect(parseSku('NOT-A-VALID-SKU')).toBeNull();
    expect(parseSku('')).toBeNull();
  });
});

describe('groupName() / groupSlug()', () => {
  it('builds human-readable group names per material+subtype', () => {
    expect(groupName('PLA', 'BAS')).toBe('Landau PLA Basic 1.75mm 1kg');
    expect(groupName('PLA', '')).toBe('Landau PLA 1.75mm 1kg');
    expect(groupName('PLA', 'REG')).toBe('Landau PLA 1.75mm 1kg');
    // "Hyper" reads as a prefix.
    expect(groupName('PETG', 'HYP')).toBe('Landau Hyper PETG 1.75mm 1kg');
  });

  it('builds URL-safe slugs', () => {
    expect(groupSlug('PLA', 'BAS')).toBe('landau-pla-basic-1-75mm-1kg');
    expect(groupSlug('PLA', '')).toBe('landau-pla-1-75mm-1kg');
    expect(groupSlug('PETG', 'HYP')).toBe('landau-petg-hyper-1-75mm-1kg');
    expect(groupSlug('PETG', 'CF')).toBe('landau-petg-carbon-fibre-1-75mm-1kg');
  });
});

describe('seedStorefront() — integration', () => {
  it('creates one group per material+subtype, one product per row', async () => {
    const result = await seedStorefront({ rows: FIXTURE_ROWS });

    expect(result.companyId).toBe(STOREFRONT_DEMO_COMPANY_ID);
    // Three groups: PLA Basic, PLA+/Pro, PETG Regular.
    expect(result.groupCount).toBe(3);
    // Six products (one per fixture row).
    expect(result.variantCount).toBe(FIXTURE_ROWS.length);
    expect(typeof result.warehouseId).toBe('string');
    expect(result.stockItemsCreated).toBe(FIXTURE_EXPECTED_STOCK_ROWS);

    const db = getDb();

    const groups = await db.query.productGroups.findMany({
      where: and(
        eq(productGroups.companyId, STOREFRONT_DEMO_COMPANY_ID),
        isNull(productGroups.deletedAt),
      ),
    });
    expect(groups).toHaveLength(3);

    const groupSlugs = groups.map((g) => g.slug).sort();
    expect(groupSlugs).toEqual([
      'landau-petg-1-75mm-1kg',
      'landau-pla-basic-1-75mm-1kg',
      'landau-pla-pro-1-75mm-1kg',
    ]);

    for (const g of groups) {
      expect(g.isPublished).toBe(true);
      expect(g.longDescription).toMatch(/^##/); // markdown heading at top
      expect(Array.isArray(g.seoKeywords)).toBe(true);
      // ProductGroupId from the spreadsheet is preserved in old_id.
      expect(g.oldId).toBe(55118);
    }

    const allProducts = await db.query.products.findMany({
      where: and(
        eq(products.companyId, STOREFRONT_DEMO_COMPANY_ID),
        isNull(products.deletedAt),
      ),
    });
    expect(allProducts).toHaveLength(FIXTURE_ROWS.length);

    for (const p of allProducts) {
      expect(p.isPublished).toBe(true);
      expect(p.colour).toBeTruthy();
      expect(p.colourHex).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(p.slug).toMatch(/^landau-/);
      expect(p.groupId).not.toBeNull();
      expect(p.heroImageUrl).toMatch(/^https:\/\//);
    }
  });

  it('only creates stock_items for SKUs with stockQty > 0', async () => {
    const result = await seedStorefront({ rows: FIXTURE_ROWS });

    const db = getDb();
    const allCompanyStock = await db.query.stockItems.findMany({
      where: and(
        eq(stockItems.companyId, STOREFRONT_DEMO_COMPANY_ID),
        isNull(stockItems.deletedAt),
      ),
    });

    expect(allCompanyStock).toHaveLength(result.stockItemsCreated);
    for (const item of allCompanyStock) {
      expect(item.status).toBe('IN_STOCK');
      expect(item.warehouseId).toBe(result.warehouseId);
    }

    // Stock-zero products should have NO stock rows.
    const productsByCode = await db.query.products.findMany({
      where: eq(products.companyId, STOREFRONT_DEMO_COMPANY_ID),
    });
    const productCodeById = new Map(productsByCode.map((p) => [p.id, p.stockCode]));

    const perProductCount = new Map<string, number>();
    for (const item of allCompanyStock) {
      const code = productCodeById.get(item.productId) ?? '?';
      perProductCount.set(code, (perProductCount.get(code) ?? 0) + 1);
    }

    for (const code of FIXTURE_IN_STOCK_SKUS) {
      const expected = FIXTURE_ROWS.find((r) => r.stockCode === code)?.stockQty ?? 0;
      expect(perProductCount.get(code)).toBe(expected);
    }
    // V3-PLA-BAS-WHITE has stockQty=0, should have no stock rows.
    expect(perProductCount.get('V3-PLA-BAS-WHITE')).toBeUndefined();
  });

  it('is idempotent: re-seeding leaves the same row counts', async () => {
    await seedStorefront({ rows: FIXTURE_ROWS });
    await seedStorefront({ rows: FIXTURE_ROWS });
    const result = await seedStorefront({ rows: FIXTURE_ROWS });

    const db = getDb();
    const groupCount = await db.query.productGroups.findMany({
      where: and(
        eq(productGroups.companyId, STOREFRONT_DEMO_COMPANY_ID),
        isNull(productGroups.deletedAt),
      ),
    });
    expect(groupCount).toHaveLength(3);

    const productCount = await db.query.products.findMany({
      where: and(
        eq(products.companyId, STOREFRONT_DEMO_COMPANY_ID),
        isNull(products.deletedAt),
      ),
    });
    expect(productCount).toHaveLength(FIXTURE_ROWS.length);

    const stock = await db.query.stockItems.findMany({
      where: and(
        eq(stockItems.companyId, STOREFRONT_DEMO_COMPANY_ID),
        isNull(stockItems.deletedAt),
      ),
    });
    expect(stock).toHaveLength(result.stockItemsCreated);
    expect(stock.every((s) => s.status === 'IN_STOCK')).toBe(true);
  });

  it('exposes the new storefront fields on the products read path', async () => {
    await seedStorefront({ rows: FIXTURE_ROWS });
    const db = getDb();
    const variant = await db.query.products.findFirst({
      where: and(
        eq(products.companyId, STOREFRONT_DEMO_COMPANY_ID),
        eq(products.slug, 'landau-pla-basic-1-75mm-1kg-black'),
      ),
      with: { group: true },
    });
    expect(variant).toBeDefined();
    expect(variant?.colour).toBe('Black');
    expect(variant?.colourHex).toBe('#1a1a1a');
    expect(variant?.heroImageUrl).toMatch(/^https:\/\//);
    expect(variant?.seoTitle).toContain('Black');
    expect(variant?.group?.slug).toBe('landau-pla-basic-1-75mm-1kg');
  });
});
