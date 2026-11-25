/**
 * Replacing the catalogue, end to end, on a throwaway company.
 *
 * The load-bearing case is the unit: Caster Sugar going from kilograms to one
 * 25 kg sack. A recipe line of 0.1 left alone would mean 0.1 SACKS - a
 * fortieth of the sugar - and nothing downstream would question it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { closeDatabase, getDb } from '../src/config/database.js';
import {
  itemCategories, products, recipeLines, recipes, sites, squareItemMap, stockLevels, stockMovements,
  stockTakeLines, stockTakes, supplierProductAliases, supplierProducts, suppliers,
} from '../src/db/schema/index.js';
import { replaceCatalogue } from './replace-catalogue.js';

const COMPANY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const P = 'RC';

async function wipe() {
  const db = getDb();
  const ids = (await db.select({ id: products.id }).from(products).where(eq(products.companyId, COMPANY))).map((p) => p.id);
  if (ids.length > 0) {
    await db.delete(recipeLines).where(inArray(recipeLines.productId, ids));
    await db.delete(supplierProductAliases).where(eq(supplierProductAliases.companyId, COMPANY));
    await db.delete(supplierProducts).where(inArray(supplierProducts.productId, ids));
    await db.delete(squareItemMap).where(inArray(squareItemMap.productId, ids));
    await db.delete(stockTakeLines).where(inArray(stockTakeLines.productId, ids));
    await db.delete(stockMovements).where(inArray(stockMovements.productId, ids));
    await db.delete(stockLevels).where(inArray(stockLevels.productId, ids));
    await db.delete(products).where(inArray(products.id, ids));
  }
  await db.delete(stockTakes).where(eq(stockTakes.companyId, COMPANY));
  await db.delete(recipes).where(eq(recipes.companyId, COMPANY));
  await db.delete(suppliers).where(eq(suppliers.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  await db.delete(itemCategories).where(eq(itemCategories.companyId, COMPANY));
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await closeDatabase();
});

const HEADER = 'stock_code,name,item_category,sub_category,stock_uom,size,purchase_uom,stock_check_instruction,comments';
const listOf = (...rows: string[]) => [HEADER, ...rows].join('\n');
const mappingOf = (...rows: string[]) => ['new_stock_code,old_stock_codes,check', ...rows].join('\n');
const removalsOf = (...codes: string[]) => ['old_stock_code,name,reason', ...codes.map((c) => `${c},,Remove.`)].join('\n');
/** Each test names its own removals, so the committed file never leaks in. */
const run = (o: Parameters<typeof replaceCatalogue>[0]) =>
  replaceCatalogue({ removalsText: removalsOf(), densitiesText: 'old_stock_code,grams_per_ml,why', ...o });
const COCKTAIL = 'SYR-COM-NEGR,Cocktail Mix - Negroni,Bar,"Syrups, Purees & Cocktail Mixes",l,Made in-house,Made in-house,Count litres (estimate part bottles),';

const SUGAR = 'BAK-SUGA-CAST,Sugar - Caster,Baking,Baking Ingredients,each,25kg,1 x 25kg,"Count bags, to the nearest quarter bag",';
const LEMON = 'BAK-FRUI-LEMO,Fruit - Lemons,Baking,Baking Ingredients,each,1 lemon,1 x net (5 lemons),Count individual lemons,';
const PIN = 'GFT-PIN-NEW,Pin - Brand New,Merchandise,Pins & Gifts,each,1 pin,Custom order,Count individual items,';

const mkProduct = async (name: string, stockCode: string, stockUom: string, extra: Partial<typeof products.$inferInsert> = {}) =>
  (await getDb().insert(products).values({ companyId: COMPANY, name, stockCode, stockUom, ...extra }).returning())[0]!.id;

let recipeN = 0;
const mkRecipeLine = async (productId: string, qty: string, uom: string, unitCost: string | null = null) => {
  const db = getDb();
  const [r] = await db
    .insert(recipes)
    .values({ companyId: COMPANY, bake: `${P} Bake ${++recipeN}`, effectiveFrom: '2026-01-01' })
    .returning();
  await db.insert(recipeLines).values({ companyId: COMPANY, recipeId: r!.id, productId, qtyPerCover: qty, stockUom: uom, unitCost });
};

const mkSupplier = async (slug: string) =>
  (await getDb().insert(suppliers).values({ companyId: COMPANY, name: `${P} ${slug}`, slug: `${P}-${slug}` }).returning())[0]!.id;

const row = async (id: string) => (await getDb().select().from(products).where(eq(products.id, id)))[0]!;

describe('replaceCatalogue', () => {
  it('re-codes in place and converts every quantity when kilograms become 25 kg sacks', async () => {
    const db = getDb();
    const sugar = await mkProduct('Caster Sugar', 'BAKE-CAST-SUGR', 'kg', { expectedNextCost: '1.5000', stockCheckInstruction: 'weigh it' });
    await mkRecipeLine(sugar, '0.1000', 'kg', '2.0000');
    const [site] = await db.insert(sites).values({ companyId: COMPANY, name: 'S', canonicalName: 'S', slug: `${P}-s` }).returning();
    await db.insert(stockMovements).values({
      companyId: COMPANY, productId: sugar, siteId: site!.id, qtyDelta: '50', movementType: 'GRN',
      sourceSystem: 'TEST', sourceKey: `${P}-m`, contentHash: `${P}-h`,
    });
    await db.insert(stockLevels).values({ companyId: COMPANY, productId: sugar, siteId: site!.id, onHand: '50', reorderPoint: '10' });
    const [take] = await db.insert(stockTakes).values({ companyId: COMPANY, siteId: site!.id, status: 'CANCELLED' }).returning();
    await db.insert(stockTakeLines).values({ stockTakeId: take!.id, productId: sugar, bookQty: '50', countedQty: '25', variance: '-25' });

    const r = await run({
      companyId: COMPANY, apply: true, listText: listOf(SUGAR), mappingText: mappingOf('BAK-SUGA-CAST,BAKE-CAST-SUGR,'),
    });
    expect(r.updated).toMatchObject([{ code: 'BAK-SUGA-CAST', from: 'BAKE-CAST-SUGR', recipeLines: 1 }]);

    const p = await row(sugar); // the SAME product, so nothing hanging off it is lost
    expect(p).toMatchObject({
      stockCode: 'BAK-SUGA-CAST', name: 'Sugar - Caster', stockUom: 'each', deletedAt: null,
      stockCheckInstruction: 'Count bags, to the nearest quarter bag', packDescription: '1 x 25kg',
    });
    expect(Number(p.expectedNextCost)).toBe(37.5); // £1.50/kg is £37.50 a sack
    const [cat] = await db.select().from(itemCategories).where(eq(itemCategories.id, p.itemCategoryId!));
    expect(cat!.name).toBe('Baking Ingredients');

    const [rl] = await db.select().from(recipeLines).where(eq(recipeLines.productId, sugar));
    expect(Number(rl!.qtyPerCover)).toBe(0.004); // 100 g of a 25 kg sack, not 0.1 sacks
    expect(Number(rl!.unitCost)).toBe(50);
    expect(rl!.stockUom).toBe('each');

    const [lvl] = await db.select().from(stockLevels).where(eq(stockLevels.productId, sugar));
    expect(Number(lvl!.onHand)).toBe(2);
    expect(Number(lvl!.reorderPoint)).toBe(0.4);
    const [line] = await db.select().from(stockTakeLines).where(eq(stockTakeLines.productId, sugar));
    expect([Number(line!.bookQty), Number(line!.countedQty), Number(line!.variance)]).toEqual([2, 1, -1]);
  });

  it('keeps the old unit AND the old instruction when the factor is not known', async () => {
    const lemon = await mkProduct('Lemons', 'LEMO', 'kg', { stockCheckInstruction: 'weigh the bag' });
    await mkRecipeLine(lemon, '0.0500', 'kg');

    const r = await run({
      companyId: COMPANY, apply: true, listText: listOf(LEMON), mappingText: mappingOf('BAK-FRUI-LEMO,LEMO,'),
    });
    expect(r.unitKept).toMatchObject([{ code: 'BAK-FRUI-LEMO', keptUom: 'kg', listUom: 'each', reason: expect.stringMatching(/1 lemon/) }]);
    expect(await row(lemon)).toMatchObject({
      stockCode: 'BAK-FRUI-LEMO', name: 'Fruit - Lemons', stockUom: 'kg', stockCheckInstruction: 'weigh the bag',
    });
    const [rl] = await getDb().select().from(recipeLines).where(eq(recipeLines.productId, lemon));
    expect(Number(rl!.qtyPerCover)).toBe(0.05);
  });

  it('refuses a conversion that would round a recipe quantity away', async () => {
    const sugar = await mkProduct('Caster Sugar', 'BAKE-CAST-SUGR', 'kg');
    await mkRecipeLine(sugar, '0.0010', 'kg'); // 1 g = 0.00004 sacks -> 0.0000

    const r = await run({
      companyId: COMPANY, apply: true, listText: listOf(SUGAR), mappingText: mappingOf('BAK-SUGA-CAST,BAKE-CAST-SUGR,'),
    });
    expect(r.unitKept[0]!.reason).toMatch(/too small/);
    expect((await row(sugar)).stockUom).toBe('kg');
  });

  it('merges a duplicate in grams, converting its recipe line and moving its supplier codes', async () => {
    const db = getDb();
    const keep = await mkProduct('Caster Sugar', 'BAKE-CAST-SUGR', 'kg');
    const dup = await mkProduct('Caster Sugar', 'CASTER-SUGAR', 'g');
    await mkRecipeLine(dup, '250', 'g');
    const brakes = await mkSupplier('brakes');
    const booker = await mkSupplier('booker');
    // Same code on both twins (the survivor's row stays), and one only on the duplicate.
    await db.insert(supplierProducts).values({ companyId: COMPANY, productId: keep, supplierId: brakes, supplierSku: '33891' });
    const [dupBrakes] = await db.insert(supplierProducts).values({ companyId: COMPANY, productId: dup, supplierId: brakes, supplierSku: '33891' }).returning();
    await db.insert(supplierProductAliases).values({ companyId: COMPANY, supplierProductId: dupBrakes!.id, supplierId: brakes, aliasSku: 'A33891' });
    await db.insert(supplierProducts).values({ companyId: COMPANY, productId: dup, supplierId: booker, supplierSku: '777' });
    // One sheet where the duplicate was counted, one where it was left blank.
    const [site] = await db.insert(sites).values({ companyId: COMPANY, name: 'S', canonicalName: 'S', slug: `${P}-s` }).returning();
    const [t1] = await db.insert(stockTakes).values({ companyId: COMPANY, siteId: site!.id, status: 'CANCELLED' }).returning();
    const [t2] = await db.insert(stockTakes).values({ companyId: COMPANY, siteId: site!.id, status: 'CANCELLED' }).returning();
    await db.insert(stockTakeLines).values([
      { stockTakeId: t1!.id, productId: dup, bookQty: '0', countedQty: '500' },
      { stockTakeId: t2!.id, productId: dup, bookQty: '0' },
    ]);

    const r = await run({
      companyId: COMPANY, apply: true, listText: listOf(SUGAR), mappingText: mappingOf('BAK-SUGA-CAST,BAKE-CAST-SUGR|CASTER-SUGAR,'),
    });
    expect(r.merged).toMatchObject([
      { code: 'BAK-SUGA-CAST', retired: 'CASTER-SUGAR', recipeLines: 1, supplierCodes: 2, historyDeleted: 1, blankLinesDeleted: 1 },
    ]);
    expect((await row(dup)).deletedAt).not.toBeNull();

    const [rl] = await db.select().from(recipeLines).where(eq(recipeLines.companyId, COMPANY));
    expect(rl!.productId).toBe(keep);
    expect(Number(rl!.qtyPerCover)).toBe(0.01); // 250 g of a 25 kg sack

    const liveCodes = await db
      .select({ sku: supplierProducts.supplierSku, id: supplierProducts.id, productId: supplierProducts.productId })
      .from(supplierProducts)
      .where(and(eq(supplierProducts.companyId, COMPANY), isNull(supplierProducts.deletedAt)));
    expect(liveCodes.map((c) => c.sku).sort()).toEqual(['33891', '777']);
    expect(liveCodes.every((c) => c.productId === keep)).toBe(true);
    // The duplicate's spelling of the code now resolves to the survivor's row.
    const [alias] = await db.select().from(supplierProductAliases).where(eq(supplierProductAliases.aliasSku, 'A33891'));
    expect(alias!.supplierProductId).toBe(liveCodes.find((c) => c.sku === '33891')!.id);
    expect(alias!.deletedAt).toBeNull();
  });

  it('leaves a duplicate alone when its unit cannot be converted', async () => {
    await mkProduct('Aquafaba - Oggs', 'AQUA', 'l');
    const dup = await mkProduct('Aquafaba', 'AQUAFABA', 'g');
    await mkRecipeLine(dup, '30', 'g');
    const r = await run({
      companyId: COMPANY, apply: true,
      listText: listOf('BAK-AQUA-OGGS,Aquafaba - Oggs,Baking,Baking Ingredients,each,1l,1 x 1l,Count bottles,'),
      mappingText: mappingOf('BAK-AQUA-OGGS,AQUA|AQUAFABA,'),
    });
    expect(r.mergeRefused).toMatchObject([{ duplicate: 'AQUAFABA', reason: expect.stringMatching(/density/) }]);
    expect(await row(dup)).toMatchObject({ deletedAt: null, stockCode: 'AQUAFABA' });
  });

  it('creates new lines, retires what the sheet removes, and keeps what is still used or was never decided', async () => {
    const db = getDb();
    const flour = await mkProduct('HP Plain Flour', 'BAKE-PLAN-FLOR', 'kg');
    await mkRecipeLine(flour, '0.2000', 'kg');
    const till = await mkProduct('Redbull', 'REDB', 'each');
    await db.insert(squareItemMap).values({ companyId: COMPANY, squareKey: `${P}-redbull`, productId: till });
    const masks = await mkProduct('Surgical Face Masks', 'SURG-FACE-MASK', 'each');
    const brakes = await mkSupplier('brakes');
    const [code] = await db.insert(supplierProducts).values({ companyId: COMPANY, productId: masks, supplierId: brakes, supplierSku: '555' }).returning();

    // Made after the sheet was drawn up: not named for removal, so nobody decided.
    const later = await mkProduct('Something New', 'MADE-LATER', 'each');

    const r = await run({
      companyId: COMPANY, apply: true, listText: listOf(PIN), mappingText: mappingOf('GFT-PIN-NEW,,'),
      removalsText: removalsOf('BAKE-PLAN-FLOR', 'REDB', 'SURG-FACE-MASK'),
    });
    expect(r.created).toEqual([{ code: 'GFT-PIN-NEW', name: 'Pin - Brand New' }]);
    const [pin] = await db.select().from(products).where(and(eq(products.companyId, COMPANY), eq(products.stockCode, 'GFT-PIN-NEW')));
    expect(pin).toMatchObject({ itemKind: 'MERCH', isSold: true, stockUom: 'each', packDescription: 'Custom order' });

    expect(r.keptNotOnList.map((k) => [k.code, k.reason]).sort()).toEqual([
      ['BAKE-PLAN-FLOR', 'the sheet says remove, but recipes still use it'],
      ['MADE-LATER', 'not in the sheet at all'],
      ['REDB', 'the sheet says remove, but a Square item still maps to it'],
    ]);
    expect((await row(later)).deletedAt).toBeNull();
    expect((await row(flour)).deletedAt).toBeNull();
    expect((await row(till)).deletedAt).toBeNull();

    expect(r.retired).toMatchObject([{ code: 'SURG-FACE-MASK', supplierCodes: 1 }]);
    expect((await row(masks)).deletedAt).not.toBeNull();
    // Its code is retired too, or aliasConflict would block it on a live product later.
    const [c] = await db.select().from(supplierProducts).where(eq(supplierProducts.id, code!.id));
    expect(c!.deletedAt).not.toBeNull();
  });

  it('reuses a category already called the same, and retires categories nothing uses any more', async () => {
    const db = getDb();
    const [cc] = await db.insert(itemCategories).values({ companyId: COMPANY, name: 'creation corner' }).returning();
    const [old] = await db.insert(itemCategories).values({ companyId: COMPANY, name: 'Ingredients' }).returning();
    const fondant = await mkProduct('Black Fondant', 'BAKE-FOND-BLAK', 'kg', { itemCategoryId: old!.id });

    const r = await run({
      companyId: COMPANY, apply: true,
      listText: listOf('CRC-FOND-BLAC,Fondant - Black,Baking,Creation Corner,kg,1kg,1 x 1kg,Count kilos,'),
      mappingText: mappingOf('CRC-FOND-BLAC,BAKE-FOND-BLAK,'),
    });
    expect(r.categoriesCreated).toEqual([]);
    expect((await row(fondant)).itemCategoryId).toBe(cc!.id);
    expect(r.categoriesRetired).toEqual(['Ingredients']);
  });

  it('writes nothing on a dry run but reports the same plan', async () => {
    const sugar = await mkProduct('Caster Sugar', 'BAKE-CAST-SUGR', 'kg');
    await mkRecipeLine(sugar, '0.1000', 'kg');
    const masks = await mkProduct('Surgical Face Masks', 'SURG-FACE-MASK', 'each');

    const r = await run({
      companyId: COMPANY, listText: listOf(SUGAR, PIN), mappingText: mappingOf('BAK-SUGA-CAST,BAKE-CAST-SUGR,', 'GFT-PIN-NEW,,'),
      removalsText: removalsOf('SURG-FACE-MASK'),
    });
    expect(r).toMatchObject({ dryRun: true, updated: [{ code: 'BAK-SUGA-CAST' }], created: [{ code: 'GFT-PIN-NEW' }], retired: [{ code: 'SURG-FACE-MASK' }] });
    expect(await row(sugar)).toMatchObject({ stockCode: 'BAKE-CAST-SUGR', stockUom: 'kg' });
    expect((await row(masks)).deletedAt).toBeNull();
    const [rl] = await getDb().select().from(recipeLines).where(eq(recipeLines.productId, sugar));
    expect(Number(rl!.qtyPerCover)).toBe(0.1);
    const all = await getDb().select().from(products).where(eq(products.companyId, COMPANY));
    expect(all).toHaveLength(2);
  });

  it('merges grams into litre bottles at a density the owners named', async () => {
    const keep = await mkProduct('Aquafaba - Oggs', 'AQUA', 'l');
    const dup = await mkProduct('Aquafaba', 'AQUAFABA', 'g');
    await mkRecipeLine(dup, '30', 'g');
    const r = await run({
      companyId: COMPANY, apply: true,
      listText: listOf('BAK-AQUA-OGGS,Aquafaba - Oggs,Baking,Baking Ingredients,each,1l,1 x 1l,Count bottles,'),
      mappingText: mappingOf('BAK-AQUA-OGGS,AQUA|AQUAFABA,'),
      densitiesText: 'old_stock_code,grams_per_ml,why\nAQUAFABA,1,bean water',
    });
    expect(r.mergeRefused).toEqual([]);
    expect(r.merged).toMatchObject([{ retired: 'AQUAFABA', recipeLines: 1 }]);
    const [rl] = await getDb().select().from(recipeLines).where(eq(recipeLines.companyId, COMPANY));
    expect(rl!.productId).toBe(keep);
    expect(Number(rl!.qtyPerCover)).toBe(0.03); // 30 g of a 1 l bottle at 1 g/ml
  });

  it('switches the unit of a product no recipe uses, clearing stock it cannot convert', async () => {
    const db = getDb();
    const mix = await mkProduct('Negroni Cocktail Mix', 'COCK-NEGR-ONI', 'bottle', { stockCheckInstruction: 'count bottles' });
    const [site] = await db.insert(sites).values({ companyId: COMPANY, name: 'S', canonicalName: 'S', slug: `${P}-s` }).returning();
    await db.insert(stockMovements).values({
      companyId: COMPANY, productId: mix, siteId: site!.id, qtyDelta: '3', movementType: 'GRN',
      sourceSystem: 'TEST', sourceKey: `${P}-m`, contentHash: `${P}-h`,
    });
    await db.insert(stockLevels).values({ companyId: COMPANY, productId: mix, siteId: site!.id, onHand: '3', reorderPoint: '2' });

    const r = await run({
      companyId: COMPANY, apply: true, listText: listOf(COCKTAIL), mappingText: mappingOf('SYR-COM-NEGR,COCK-NEGR-ONI,'),
    });
    expect(r.unitKept).toEqual([]);
    expect(r.unitSwitched).toMatchObject([{ code: 'SYR-COM-NEGR', oldUom: 'bottle', newUom: 'l' }]);
    expect(await row(mix)).toMatchObject({ stockUom: 'l', stockCheckInstruction: 'Count litres (estimate part bottles)' });
    // 3 bottles is not 3 litres: cleared, not reinterpreted.
    const [lvl] = await db.select().from(stockLevels).where(eq(stockLevels.productId, mix));
    expect(Number(lvl!.onHand)).toBe(0);
    expect(lvl!.reorderPoint).toBeNull();
    expect(await db.select().from(stockMovements).where(eq(stockMovements.productId, mix))).toHaveLength(0);
  });

  it('cancels the open counts first when asked, and only then', async () => {
    const db = getDb();
    await mkProduct('Caster Sugar', 'BAKE-CAST-SUGR', 'kg');
    const [site] = await db.insert(sites).values({ companyId: COMPANY, name: 'S', canonicalName: 'S', slug: `${P}-s` }).returning();
    const [take] = await db.insert(stockTakes).values({ companyId: COMPANY, siteId: site!.id, status: 'OPEN' }).returning();
    const args = { companyId: COMPANY, apply: true, listText: listOf(SUGAR), mappingText: mappingOf('BAK-SUGA-CAST,BAKE-CAST-SUGR,') };

    const dry = await run({ ...args, apply: false });
    expect(dry).toMatchObject({ openStockTakes: 1, openStockTakesCancelled: 0 });

    const r = await run({ ...args, cancelOpenCounts: true });
    expect(r).toMatchObject({ openStockTakes: 1, openStockTakesCancelled: 1 });
    const [t] = await db.select().from(stockTakes).where(eq(stockTakes.id, take!.id));
    expect(t!.status).toBe('CANCELLED');
  });

  it('refuses outright when the mapping names a product this catalogue does not have', async () => {
    await expect(
      run({ companyId: COMPANY, apply: true, listText: listOf(SUGAR), mappingText: mappingOf('BAK-SUGA-CAST,NO-SUCH-CODE,') }),
    ).rejects.toThrow(/no live product with stock code NO-SUCH-CODE/);
  });
});
