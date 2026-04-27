/**
 * Integration tests for the seed:storefront script.
 *
 * Hits a real Postgres at DATABASE_URL (the docker-compose instance by
 * default). Mutates only the Storefront Demo company's rows, identified by
 * a fixed companyId.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, productGroups } from '../src/db/schema/index.js';
import { STOREFRONT_DEMO_COMPANY_ID, seedStorefront } from './seed-storefront.js';

afterAll(async () => {
  await closeDatabase();
});

describe('seedStorefront() — integration', () => {
  it('creates one published group, three colour variants, one standalone product', async () => {
    const result = await seedStorefront();

    expect(result.companyId).toBe(STOREFRONT_DEMO_COMPANY_ID);
    expect(result.variantIds).toHaveLength(3);
    expect(typeof result.standaloneId).toBe('string');

    const db = getDb();

    const groups = await db.query.productGroups.findMany({
      where: and(
        eq(productGroups.companyId, STOREFRONT_DEMO_COMPANY_ID),
        isNull(productGroups.deletedAt),
      ),
    });
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group?.isPublished).toBe(true);
    expect(group?.slug).toBe('aurora-filament-lamp');
    expect(group?.heroImageUrl).toMatch(/^https:\/\/picsum\.photos\//);
    expect(Array.isArray(group?.galleryImageUrls)).toBe(true);
    expect(group?.galleryImageUrls?.length).toBeGreaterThan(0);
    expect(Array.isArray(group?.seoKeywords)).toBe(true);

    const allProducts = await db.query.products.findMany({
      where: and(
        eq(products.companyId, STOREFRONT_DEMO_COMPANY_ID),
        isNull(products.deletedAt),
      ),
    });
    expect(allProducts).toHaveLength(4);

    const variants = allProducts.filter((p) => p.groupId === group?.id);
    expect(variants).toHaveLength(3);
    for (const v of variants) {
      expect(v.isPublished).toBe(true);
      expect(v.colour).toBeTruthy();
      expect(v.colourHex).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(v.slug).toMatch(/^aurora-filament-lamp-/);
    }

    const standalones = allProducts.filter((p) => p.groupId === null);
    expect(standalones).toHaveLength(1);
    expect(standalones[0]?.isPublished).toBe(true);
    expect(standalones[0]?.slug).toBe('brushed-brass-pendant-cord-set');
  });

  it('is idempotent: re-seeding leaves the same row counts', async () => {
    await seedStorefront();
    await seedStorefront();
    await seedStorefront();

    const db = getDb();
    const groupCount = await db.query.productGroups.findMany({
      where: and(
        eq(productGroups.companyId, STOREFRONT_DEMO_COMPANY_ID),
        isNull(productGroups.deletedAt),
      ),
    });
    expect(groupCount).toHaveLength(1);

    const productCount = await db.query.products.findMany({
      where: and(
        eq(products.companyId, STOREFRONT_DEMO_COMPANY_ID),
        isNull(products.deletedAt),
      ),
    });
    expect(productCount).toHaveLength(4);
  });

  it('exposes the new storefront fields on the products read path', async () => {
    await seedStorefront();
    const db = getDb();
    const variant = await db.query.products.findFirst({
      where: and(
        eq(products.companyId, STOREFRONT_DEMO_COMPANY_ID),
        eq(products.slug, 'aurora-filament-lamp-smoke'),
      ),
      with: { group: true },
    });
    expect(variant).toBeDefined();
    expect(variant?.colour).toBe('Smoke');
    expect(variant?.colourHex).toBe('#3a3a3a');
    expect(variant?.heroImageUrl).toMatch(/^https:\/\/picsum\.photos\//);
    expect(variant?.seoTitle).toContain('Smoke');
    expect(variant?.group?.slug).toBe('aurora-filament-lamp');
  });
});
