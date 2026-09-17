/**
 * The recipe-unit invariant.
 *
 * A recipe line carries its own `stock_uom`, and nothing in the system converts
 * units — so the line and its product are only correct when they agree. The
 * case that matters is the one that created this check: a product's unit
 * changed by hand, leaving lines denominated in the old one.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import { products, recipeLines, recipes } from '../src/db/schema/index.js';
import { checkRecipeUnits } from './check-recipe-units.js';

const COMPANY = 'eeee1111-eeee-4eee-8eee-eeeeeeee1111';
const PREFIX = 'UNITCHK';

async function wipe() {
  const db = getDb();
  const ps = await db.select({ id: products.id }).from(products).where(eq(products.companyId, COMPANY));
  const ids = ps.map((p) => p.id);
  if (ids.length > 0) {
    await db.delete(recipeLines).where(inArray(recipeLines.productId, ids));
    await db.delete(products).where(inArray(products.id, ids));
  }
  await db.delete(recipes).where(eq(recipes.companyId, COMPANY));
}

async function line(productUom: string, lineUom: string, qty: string, name = 'Soya Milk') {
  const db = getDb();
  const [p] = await db
    .insert(products)
    .values({ companyId: COMPANY, name, stockCode: `${PREFIX}-${name.replace(/\W/g, '')}`, stockUom: productUom })
    .returning();
  const [r] = await db
    .insert(recipes)
    .values({ companyId: COMPANY, bake: `${PREFIX} Bake`, effectiveFrom: '2026-01-01' })
    .returning();
  await db.insert(recipeLines).values({
    companyId: COMPANY, recipeId: r!.id, productId: p!.id, qtyPerCover: qty, stockUom: lineUom,
  });
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await closeDatabase();
});

describe('checkRecipeUnits', () => {
  it('says nothing when the line and its product agree', async () => {
    await line('kg', 'kg', '0.25');
    expect(await checkRecipeUnits(COMPANY)).toEqual([]);
  });

  it('ignores a difference that is only spelling', async () => {
    await line('l', 'ltr', '0.5');
    expect(await checkRecipeUnits(COMPANY)).toEqual([]);
  });

  /**
   * Exactly the hole this closes. The merge refuses litres-against-grams, the
   * operator sets the grams twin to litres to get past it, and the merge then
   * sees two products agreeing and moves 500 g across untouched — as 500
   * LITRES of milk per cover.
   */
  it('catches a gram quantity left on a product now tracked in litres', async () => {
    await line('l', 'g', '500');
    const [m] = await checkRecipeUnits(COMPANY);
    expect(m).toMatchObject({ lineUom: 'g', productUom: 'l', qtyPerCover: 500 });
    // g -> l needs a density, so it must not offer a number.
    expect(m!.factor).toBeNull();
    expect(m!.suggested).toBeNull();
  });

  it('suggests the corrected quantity where the units do convert', async () => {
    await line('kg', 'g', '250');
    const [m] = await checkRecipeUnits(COMPANY);
    expect(m).toMatchObject({ lineUom: 'g', productUom: 'kg', factor: 0.001, suggested: 0.25 });
  });

  it('ignores a soft-deleted product', async () => {
    await line('l', 'g', '500');
    await getDb().update(products).set({ deletedAt: new Date() }).where(eq(products.companyId, COMPANY));
    expect(await checkRecipeUnits(COMPANY)).toEqual([]);
  });

  it('reports every offending line, not just the first', async () => {
    await line('l', 'g', '500', 'Soya Milk');
    await line('kg', 'g', '250', 'Caster Sugar');
    expect(await checkRecipeUnits(COMPANY)).toHaveLength(2);
  });
});
