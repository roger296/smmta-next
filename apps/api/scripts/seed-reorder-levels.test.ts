/**
 * The property that matters: re-running must not undo hand-tuned levels.
 *
 * These are seeded flat at 5 and then adjusted per item over time. A seeder
 * that overwrote on every run would silently reset that work, and nobody would
 * notice until a site quietly stopped flagging something it used to.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, sites, stockLevels } from '../src/db/schema/index.js';
import { getSingletonCompanyId } from '../src/shared/auth/company.js';
import { seedReorderLevels } from './seed-reorder-levels.js';
import { seedSites } from './seed-sites.js';

const COMPANY = getSingletonCompanyId();

describe('seedReorderLevels', () => {
  beforeAll(async () => {
    await seedSites();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it('reports the full product x site grid without writing on a dry run', async () => {
    const before = await seedReorderLevels({ point: 5, dryRun: true });
    expect(before.pairs).toBe(before.products * before.sites);
    expect(before.set + before.leftAlone).toBe(before.pairs);

    // A dry run changes nothing, so a second one proposes exactly as much.
    const again = await seedReorderLevels({ point: 5, dryRun: true });
    expect(again.set).toBe(before.set);
  });

  it('sets every unset pair, then leaves them alone on a re-run', async () => {
    const first = await seedReorderLevels({ point: 5 });
    const second = await seedReorderLevels({ point: 5 });
    expect(second.set).toBe(0);
    expect(second.leftAlone).toBe(first.pairs);
  });

  it('does not overwrite a tuned level unless forced', async () => {
    await seedReorderLevels({ point: 5 });
    const db = getDb();
    const product = await db.query.products.findFirst({ where: eq(products.companyId, COMPANY) });
    const site = await db.query.sites.findFirst({ where: eq(sites.companyId, COMPANY) });
    if (!product || !site) return; // nothing seeded in this environment

    await db
      .update(stockLevels)
      .set({ reorderPoint: '42' })
      .where(
        and(
          eq(stockLevels.companyId, COMPANY),
          eq(stockLevels.productId, product.id),
          eq(stockLevels.siteId, site.id),
        ),
      );

    await seedReorderLevels({ point: 5 });
    const kept = await db.query.stockLevels.findFirst({
      where: and(
        eq(stockLevels.companyId, COMPANY),
        eq(stockLevels.productId, product.id),
        eq(stockLevels.siteId, site.id),
      ),
    });
    expect(Number(kept?.reorderPoint)).toBe(42);

    await seedReorderLevels({ point: 5, force: true });
    const forced = await db.query.stockLevels.findFirst({
      where: and(
        eq(stockLevels.companyId, COMPANY),
        eq(stockLevels.productId, product.id),
        eq(stockLevels.siteId, site.id),
      ),
    });
    expect(Number(forced?.reorderPoint)).toBe(5);
  });

  it('never disturbs on-hand — a reorder point is not a stock movement', async () => {
    const db = getDb();
    const product = await db.query.products.findFirst({ where: eq(products.companyId, COMPANY) });
    const site = await db.query.sites.findFirst({ where: eq(sites.companyId, COMPANY) });
    if (!product || !site) return;

    await db
      .update(stockLevels)
      .set({ onHand: '17.5' })
      .where(
        and(
          eq(stockLevels.companyId, COMPANY),
          eq(stockLevels.productId, product.id),
          eq(stockLevels.siteId, site.id),
        ),
      );

    await seedReorderLevels({ point: 5, force: true });
    const row = await db.query.stockLevels.findFirst({
      where: and(
        eq(stockLevels.companyId, COMPANY),
        eq(stockLevels.productId, product.id),
        eq(stockLevels.siteId, site.id),
      ),
    });
    expect(Number(row?.onHand)).toBe(17.5);
  });
});
