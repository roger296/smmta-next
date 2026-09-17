/**
 * Merging duplicate products, end to end.
 *
 * The load-bearing test is the conversion: a recipe line of 250 g landing on a
 * kilograms product as 250 would make every bake consume a thousand times too
 * much, and nothing downstream would question it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import {
  products, recipeLines, recipes, sites, stockLevels, stockMovements, stockTakeLines, stockTakes,
  suppliers, supplierProducts,
} from '../src/db/schema/index.js';
import { mergeDuplicateProducts } from './merge-duplicate-products.js';

const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PREFIX = 'MERGE';

async function wipe() {
  const db = getDb();
  const ps = await db.select({ id: products.id }).from(products).where(eq(products.companyId, COMPANY));
  const ids = ps.map((p) => p.id);
  if (ids.length > 0) {
    await db.delete(recipeLines).where(inArray(recipeLines.productId, ids));
    await db.delete(supplierProducts).where(inArray(supplierProducts.productId, ids));
    await db.delete(stockTakeLines).where(inArray(stockTakeLines.productId, ids));
    await db.delete(stockMovements).where(inArray(stockMovements.productId, ids));
    await db.delete(stockLevels).where(inArray(stockLevels.productId, ids));
    await db.delete(products).where(inArray(products.id, ids));
  }
  await db.delete(stockTakes).where(eq(stockTakes.companyId, COMPANY));
  await db.delete(recipes).where(eq(recipes.companyId, COMPANY));
  await db.delete(suppliers).where(eq(suppliers.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
}

const mkProduct = async (name: string, stockCode: string, stockUom: string) =>
  (await getDb().insert(products).values({ companyId: COMPANY, name, stockCode, stockUom }).returning())[0]!.id;

const mkRecipeLine = async (productId: string, qty: string, uom: string) => {
  const db = getDb();
  const [r] = await db
    .insert(recipes)
    .values({ companyId: COMPANY, bake: `${PREFIX} Bake`, effectiveFrom: '2026-01-01' })
    .returning();
  await db.insert(recipeLines).values({
    companyId: COMPANY, recipeId: r!.id, productId, qtyPerCover: qty, stockUom: uom,
  });
};

const mkSupplierCode = async (productId: string, sku: string) => {
  const db = getDb();
  const [s] = await db
    .insert(suppliers)
    .values({ companyId: COMPANY, name: `${PREFIX} Brakes`, slug: `${PREFIX}-brakes-${sku}` })
    .returning();
  await db.insert(supplierProducts).values({
    companyId: COMPANY, productId, supplierId: s!.id, supplierSku: sku,
  });
};

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await closeDatabase();
});

const live = async (stockCode: string) =>
  (await getDb()
    .select()
    .from(products)
    .where(and(eq(products.stockCode, stockCode), isNull(products.deletedAt))))[0];

describe('mergeDuplicateProducts', () => {
  /** Caster Sugar, exactly as production had it. */
  it('divides the recipe quantity when grams merge into kilograms', async () => {
    const keep = await mkProduct('Caster Sugar', `${PREFIX}-KG`, 'kg');
    const retire = await mkProduct('Caster Sugar', `${PREFIX}-G`, 'g');
    await mkSupplierCode(keep, '33891');
    await mkRecipeLine(retire, '250', 'g');

    const r = await mergeDuplicateProducts({ companyId: COMPANY, apply: true });
    expect(r.merged).toHaveLength(1);
    expect(r.merged[0]).toMatchObject({ keep: `${PREFIX}-KG`, retire: `${PREFIX}-G`, factor: 0.001 });

    const [rl] = await getDb().select().from(recipeLines).where(eq(recipeLines.companyId, COMPANY));
    expect(rl!.productId).toBe(keep);
    expect(Number(rl!.qtyPerCover)).toBe(0.25);   // 250 g, not 250 kg
    expect(rl!.stockUom).toBe('kg');
  });

  it('soft-deletes the retired twin and leaves the survivor live', async () => {
    const keep = await mkProduct('Caster Sugar', `${PREFIX}-KG`, 'kg');
    const retire = await mkProduct('Caster Sugar', `${PREFIX}-G`, 'g');
    await mkSupplierCode(keep, '33891');
    await mkRecipeLine(retire, '250', 'g');

    await mergeDuplicateProducts({ companyId: COMPANY, apply: true });
    expect(await live(`${PREFIX}-KG`)).toBeDefined();
    expect(await live(`${PREFIX}-G`)).toBeUndefined();
  });

  it('writes nothing on a dry run but reports the same plan', async () => {
    const keep = await mkProduct('Caster Sugar', `${PREFIX}-KG`, 'kg');
    const retire = await mkProduct('Caster Sugar', `${PREFIX}-G`, 'g');
    await mkSupplierCode(keep, '33891');
    await mkRecipeLine(retire, '250', 'g');

    const r = await mergeDuplicateProducts({ companyId: COMPANY });
    expect(r.merged[0]).toMatchObject({ factor: 0.001, recipeLinesMoved: 1 });
    expect(await live(`${PREFIX}-G`)).toBeDefined();
    const [rl] = await getDb().select().from(recipeLines).where(eq(recipeLines.companyId, COMPANY));
    expect(Number(rl!.qtyPerCover)).toBe(250);
  });

  it('moves supplier codes that sat on the retired twin', async () => {
    // Codes on the GRAMS twin: the unit still decides, and the code moves.
    const keep = await mkProduct('Olives', `${PREFIX}-KEEP`, 'kg');
    const retire = await mkProduct('Olives', `${PREFIX}-RETIRE`, 'g');
    await mkSupplierCode(retire, '119649');

    await mergeDuplicateProducts({ companyId: COMPANY, apply: true });
    const [sp] = await getDb().select().from(supplierProducts).where(eq(supplierProducts.companyId, COMPANY));
    expect(sp!.productId).toBe(keep);
  });

  /**
   * Semi-skimmed milk, soya milk and rapeseed oil all exist as litres on one
   * twin and grams on the other. Guessing 1 g = 1 ml is water's density and is
   * 8% out for the oil, on every recipe line, forever.
   */
  it('refuses litres against grams and changes nothing for that pair', async () => {
    const keep = await mkProduct('Long Life Semi Skimmed Milk', `${PREFIX}-L`, 'l');
    const retire = await mkProduct('Long Life Semi Skimmed Milk', `${PREFIX}-G`, 'g');
    await mkSupplierCode(keep, '19665');
    await mkRecipeLine(retire, '500', 'g');

    const r = await mergeDuplicateProducts({ companyId: COMPANY, apply: true });
    expect(r.merged).toHaveLength(0);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0]!.refusal).toMatch(/density/);
    expect(await live(`${PREFIX}-G`)).toBeDefined();
    const [rl] = await getDb().select().from(recipeLines).where(eq(recipeLines.companyId, COMPANY));
    expect(Number(rl!.qtyPerCover)).toBe(500);
  });

  /**
   * The invented counts are due to be zeroed before the first real count.
   * Carrying one through a unit change would be inventing a different number.
   */
  it('discards the retired twin s test stock rather than converting it', async () => {
    const db = getDb();
    const keep = await mkProduct('Caster Sugar', `${PREFIX}-KG`, 'kg');
    const retire = await mkProduct('Caster Sugar', `${PREFIX}-G`, 'g');
    await mkSupplierCode(keep, '33891');
    const [site] = await db
      .insert(sites)
      .values({ companyId: COMPANY, name: 'S', canonicalName: 'S', slug: `${PREFIX}-s` })
      .returning();
    await db.insert(stockMovements).values({
      companyId: COMPANY, productId: retire, siteId: site!.id, qtyDelta: '-4600',
      movementType: 'CONSUMPTION', sourceSystem: 'TEST', sourceKey: `${PREFIX}-m`, contentHash: `${PREFIX}-h`,
    });
    await db.insert(stockLevels).values({
      companyId: COMPANY, productId: retire, siteId: site!.id, onHand: '-4600',
    });

    const r = await mergeDuplicateProducts({ companyId: COMPANY, apply: true });
    expect(r.merged[0]!.movementsDeleted).toBe(1);
    expect(await db.select().from(stockMovements).where(eq(stockMovements.productId, retire))).toHaveLength(0);
    expect(await db.select().from(stockLevels).where(eq(stockLevels.productId, retire))).toHaveLength(0);
    // Nothing invented on the survivor.
    expect(await db.select().from(stockLevels).where(eq(stockLevels.productId, keep))).toHaveLength(0);
  });

  /**
   * The failure the first live --apply hit. `stock_take_lines` is unique on
   * (stock_take_id, product_id), and a count sheet listing a duplicated product
   * has a row for EACH twin — which is exactly what a duplicate is. Repointing
   * collided on the constraint and the run died part-way through the list.
   */
  it('survives both twins appearing on the same stock take', async () => {
    const db = getDb();
    const keep = await mkProduct('Caster Sugar', `${PREFIX}-KG`, 'kg');
    const retire = await mkProduct('Caster Sugar', `${PREFIX}-G`, 'g');
    await mkSupplierCode(keep, '33891');
    await mkRecipeLine(retire, '250', 'g');
    const [site] = await db
      .insert(sites)
      .values({ companyId: COMPANY, name: 'S', canonicalName: 'S', slug: `${PREFIX}-s` })
      .returning();
    const [take] = await db
      .insert(stockTakes)
      .values({ companyId: COMPANY, siteId: site!.id, status: 'OPEN' })
      .returning();
    // One line per twin, on the SAME take.
    await db.insert(stockTakeLines).values([
      { stockTakeId: take!.id, productId: keep, bookQty: '2', countedQty: '2' },
      { stockTakeId: take!.id, productId: retire, bookQty: '2000', countedQty: '2000' },
    ]);

    const r = await mergeDuplicateProducts({ companyId: COMPANY, apply: true });
    expect(r.merged).toHaveLength(1);
    expect(r.merged[0]!.historyDeleted).toBe(1);
    // The survivor's own count line is untouched; the retired twin's is gone,
    // not repointed — 2000 grams is not 2000 kilograms.
    const lines = await db.select().from(stockTakeLines).where(eq(stockTakeLines.stockTakeId, take!.id));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.productId).toBe(keep);
    expect(Number(lines[0]!.countedQty)).toBe(2);
  });

  /**
   * `recipe_lines` is unique on (recipe, product, variant, component). Summing
   * would add grams to kilograms; dropping one would silently lose an
   * ingredient from a cake. Neither is this script's call.
   */
  it('refuses a pair whose recipe names both twins in one section', async () => {
    const db = getDb();
    const keep = await mkProduct('Caster Sugar', `${PREFIX}-KG`, 'kg');
    const retire = await mkProduct('Caster Sugar', `${PREFIX}-G`, 'g');
    await mkSupplierCode(keep, '33891');
    const [r0] = await db
      .insert(recipes)
      .values({ companyId: COMPANY, bake: `${PREFIX} Bake`, effectiveFrom: '2026-01-01' })
      .returning();
    await db.insert(recipeLines).values([
      { companyId: COMPANY, recipeId: r0!.id, productId: keep, qtyPerCover: '0.25', stockUom: 'kg' },
      { companyId: COMPANY, recipeId: r0!.id, productId: retire, qtyPerCover: '250', stockUom: 'g' },
    ]);

    const r = await mergeDuplicateProducts({ companyId: COMPANY, apply: true });
    expect(r.merged).toHaveLength(0);
    expect(r.refused[0]!.refusal).toMatch(/uses BOTH twins/);
    expect(await live(`${PREFIX}-G`)).toBeDefined();
  });

  /** Both twins carrying the same supplier's same code: keep one, drop the other. */
  it('drops a supplier code the survivor already holds instead of colliding', async () => {
    const db = getDb();
    const keep = await mkProduct('Olives', `${PREFIX}-KEEP`, 'kg');
    const retire = await mkProduct('Olives', `${PREFIX}-RETIRE`, 'g');
    const [sup] = await db
      .insert(suppliers)
      .values({ companyId: COMPANY, name: `${PREFIX} Brakes`, slug: `${PREFIX}-brakes-dup` })
      .returning();
    await db.insert(supplierProducts).values([
      { companyId: COMPANY, productId: keep, supplierId: sup!.id, supplierSku: '119649' },
      { companyId: COMPANY, productId: retire, supplierId: sup!.id, supplierSku: '119649' },
    ]);

    await mergeDuplicateProducts({ companyId: COMPANY, apply: true });
    const codes = await db.select().from(supplierProducts).where(eq(supplierProducts.companyId, COMPANY));
    expect(codes).toHaveLength(1);
    expect(codes[0]!.productId).toBe(keep);
  });

  it('leaves a name used by three products alone - that is not a pair', async () => {
    for (const n of ['A', 'B', 'C']) await mkProduct('Triple', `${PREFIX}-${n}`, 'kg');
    const r = await mergeDuplicateProducts({ companyId: COMPANY, apply: true });
    expect(r.merged).toHaveLength(0);
    expect(r.refused).toHaveLength(0);
    for (const n of ['A', 'B', 'C']) expect(await live(`${PREFIX}-${n}`)).toBeDefined();
  });

  it('hands back a pair with nothing to choose between', async () => {
    await mkProduct('Brown', `${PREFIX}-1`, 'kg');
    await mkProduct('Brown', `${PREFIX}-2`, 'kg');
    const r = await mergeDuplicateProducts({ companyId: COMPANY, apply: true });
    expect(r.refused).toHaveLength(1);
    expect(await live(`${PREFIX}-1`)).toBeDefined();
    expect(await live(`${PREFIX}-2`)).toBeDefined();
  });

  it('is idempotent - a second run finds no duplicates left', async () => {
    const keep = await mkProduct('Caster Sugar', `${PREFIX}-KG`, 'kg');
    const retire = await mkProduct('Caster Sugar', `${PREFIX}-G`, 'g');
    await mkSupplierCode(keep, '33891');
    await mkRecipeLine(retire, '250', 'g');

    await mergeDuplicateProducts({ companyId: COMPANY, apply: true });
    const second = await mergeDuplicateProducts({ companyId: COMPANY, apply: true });
    expect(second.merged).toHaveLength(0);
    expect(second.refused).toHaveLength(0);
    const [rl] = await getDb().select().from(recipeLines).where(eq(recipeLines.companyId, COMPANY));
    expect(Number(rl!.qtyPerCover)).toBe(0.25);   // not divided twice
  });
});
