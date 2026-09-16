/**
 * Splitting the bake form into per-diet sections (Sept-2026 testing, item 5)
 * and allowing one ingredient on several lines (item 6).
 *
 * "When there are items on the vegan or GF recipe that are the same as those on
 *  the regular recipe, we currently combine them onto one line in the end of
 *  bake form, users found this confusing so please split the different recipe
 *  sections into separate sections with headers."
 *
 * ⚠️ THE PROPERTY THAT MATTERS is the last describe block: the section totals
 * must equal what the merged line used to say. These numbers drive stock
 * movements and the materials cost. A split that quietly shifted them would
 * misstate every bake from the day it shipped, and nothing would error.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { products, recipeLines, recipes, sites } from '../../db/schema/index.js';
import { RecipeService } from './recipe.service.js';
import { ExpectedConsumptionService } from './expected-consumption.service.js';
import type { ExpectedLine } from './expected-consumption.service.js';

const COMPANY = 'a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a7a7';
const recipeSvc = new RecipeService();
const expected = new ExpectedConsumptionService();

const CAKE = 'Section Sponge';
let siteId: string;
let flour: string;
let gfFlour: string;
let butter: string;
let veganBlock: string;
let icing: string;

async function seed(): Promise<void> {
  const db = getDb();
  const mk = async (name: string, slug: string) => {
    const [p] = await db
      .insert(products)
      .values({
        companyId: COMPANY,
        name,
        slug,
        itemKind: 'INGREDIENT',
        stockUom: 'g',
        expectedNextCost: '0.01',
      })
      .returning();
    return p!.id;
  };
  const [s] = await db
    .insert(sites)
    .values({
      companyId: COMPANY,
      name: 'Section Site',
      slug: 'section-site',
      canonicalName: 'section-site',
    })
    .returning();
  siteId = s!.id;
  flour = await mk('S Flour', 's-flour');
  gfFlour = await mk('S GF Flour', 's-gf-flour');
  butter = await mk('S Butter', 's-butter');
  veganBlock = await mk('S Vegan Block', 's-vegan-block');
  icing = await mk('S Icing Sugar', 's-icing');
}

/** Flour + butter + icing sugar; GF swaps the flour, vegan swaps the butter. */
async function mixedDietRecipe(): Promise<void> {
  await recipeSvc.create({
    bake: CAKE,
    effectiveFrom: '2026-01-01',
    companyId: COMPANY,
    lines: [
      { productId: flour, qtyPerCover: 100 },
      { productId: butter, qtyPerCover: 50 },
      { productId: icing, qtyPerCover: 20 },
      { productId: flour, qtyPerCover: 0, variant: 'GF_REMOVE' },
      { productId: gfFlour, qtyPerCover: 110, variant: 'GF_ADD' },
      { productId: butter, qtyPerCover: 0, variant: 'VEGAN_REMOVE' },
      { productId: veganBlock, qtyPerCover: 55, variant: 'VEGAN_ADD' },
    ],
  });
}

const forSession = (covers: number, gf = 0, vegan = 0) =>
  expected.expectedForSession({
    bake: CAKE,
    siteId,
    covers,
    glutenFreeTables: gf,
    veganTables: vegan,
    onDate: '2026-09-16',
    companyId: COMPANY,
  });

const inSection = (lines: ExpectedLine[], section: string) =>
  Object.fromEntries(
    lines.filter((l) => l.section === section).map((l) => [l.productName, l.expectedQty]),
  );

beforeEach(async () => {
  const db = getDb();
  await db.delete(recipeLines).where(eq(recipeLines.companyId, COMPANY));
  await db.delete(recipes).where(eq(recipes.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  await seed();
});

afterAll(async () => {
  const db = getDb();
  await db.delete(recipeLines).where(eq(recipeLines.companyId, COMPANY));
  await db.delete(recipes).where(eq(recipes.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  await closeDatabase();
});

describe('item 5: each diet gets its own section, carrying its FULL list', () => {
  it('gives a vegan bench every ingredient it uses, not just the swaps', async () => {
    await mixedDietRecipe();
    const lines = await forSession(5, 0, 2); // 3 regular, 2 vegan

    // The vegan benches still use flour and icing sugar. A baker on that bench
    // needs the whole list in one place — a section of nothing but "vegan
    // block" would have them applying swaps in their head.
    expect(inSection(lines, 'VEGAN')).toEqual({
      'S Flour': 200, // 100 × 2
      'S Icing Sugar': 40, // 20 × 2
      'S Vegan Block': 110, // 55 × 2
    });
    // …and NOT the butter it replaced.
    expect(inSection(lines, 'VEGAN')['S Butter']).toBeUndefined();
  });

  it('scopes the regular section to the regular benches only', async () => {
    await mixedDietRecipe();
    const lines = await forSession(5, 0, 2);

    expect(inSection(lines, 'REGULAR')).toEqual({
      'S Flour': 300, // 100 × 3
      'S Butter': 150, // 50 × 3
      'S Icing Sugar': 60, // 20 × 3
    });
  });

  it('splits all three ways at once', async () => {
    await mixedDietRecipe();
    const lines = await forSession(6, 2, 1); // 3 regular, 2 GF, 1 vegan

    expect(inSection(lines, 'GLUTEN_FREE')).toEqual({
      'S GF Flour': 220,
      'S Butter': 100,
      'S Icing Sugar': 40,
    });
    expect(inSection(lines, 'VEGAN')).toEqual({
      'S Flour': 100,
      'S Vegan Block': 55,
      'S Icing Sugar': 20,
    });
  });

  it('puts the SAME product on two lines when two diets both use it', async () => {
    // This is the behaviour users asked for: "Even though this will result in
    // multiple lines for the same product."
    await mixedDietRecipe();
    const lines = await forSession(5, 0, 2);

    const flourLines = lines.filter((l) => l.productName === 'S Flour');
    expect(flourLines.map((l) => l.section).sort()).toEqual(['REGULAR', 'VEGAN']);
  });

  it('omits a section with no benches rather than showing an empty heading', async () => {
    await mixedDietRecipe();
    const lines = await forSession(5);
    expect(new Set(lines.map((l) => l.section))).toEqual(new Set(['REGULAR']));
  });

  it('carries the bench count each figure is for, so the row can show N / M', async () => {
    await mixedDietRecipe();
    const lines = await forSession(5, 0, 2);
    expect(lines.find((l) => l.section === 'REGULAR')!.benches).toBe(3);
    expect(lines.find((l) => l.section === 'VEGAN')!.benches).toBe(2);
  });

  it('clamps regular at zero when every bench is on a diet', async () => {
    await mixedDietRecipe();
    const lines = await forSession(2, 0, 2);
    expect(lines.some((l) => l.section === 'REGULAR')).toBe(false);
  });

  it('does not go negative if the leader types more diet benches than benches', async () => {
    // A typing mistake, not a reason to subtract from the bake.
    await mixedDietRecipe();
    const lines = await forSession(2, 3, 3);
    expect(lines.every((l) => l.expectedQty >= 0)).toBe(true);
    expect(lines.some((l) => l.section === 'REGULAR')).toBe(false);
  });
});

describe('item 6: one ingredient, several parts of the cake', () => {
  it('keeps icing sugar in the cake separate from icing sugar in the topping', async () => {
    await recipeSvc.create({
      bake: CAKE,
      effectiveFrom: '2026-01-01',
      companyId: COMPANY,
      lines: [
        { productId: flour, qtyPerCover: 100, component: 'Cake' },
        { productId: icing, qtyPerCover: 20, component: 'Cake' },
        { productId: icing, qtyPerCover: 75, component: 'Topping' },
      ],
    });
    const lines = await forSession(4);

    const icingLines = lines
      .filter((l) => l.productName === 'S Icing Sugar')
      .sort((a, b) => a.component.localeCompare(b.component));
    expect(icingLines).toHaveLength(2);
    expect(icingLines.map((l) => [l.component, l.expectedQty])).toEqual([
      ['Cake', 80],
      ['Topping', 300],
    ]);
  });

  it('removes the ingredient from ONE part only', async () => {
    // Removing the topping's icing sugar for a vegan bench must not also take
    // out the icing sugar inside the cake. Matching on the product alone would.
    await recipeSvc.create({
      bake: CAKE,
      effectiveFrom: '2026-01-01',
      companyId: COMPANY,
      lines: [
        { productId: icing, qtyPerCover: 20, component: 'Cake' },
        { productId: icing, qtyPerCover: 75, component: 'Topping' },
        { productId: icing, qtyPerCover: 0, variant: 'VEGAN_REMOVE', component: 'Topping' },
      ],
    });
    const lines = await forSession(3, 0, 1);

    const vegan = lines.filter((l) => l.section === 'VEGAN');
    expect(vegan.map((l) => l.component)).toEqual(['Cake']);
    expect(vegan[0]!.expectedQty).toBe(20);
  });
});

describe('⚠️ the section totals still sum to the old merged figure', () => {
  /** The rule as it was before the split — `dietary-expected.test.ts`'s model. */
  function merged(covers: number, gf: number, vegan: number): Record<string, number> {
    const out: Record<string, number> = {
      'S Flour': 100 * covers,
      'S Butter': 50 * covers,
      'S Icing Sugar': 20 * covers,
    };
    out['S Flour'] -= 100 * gf; // GF_REMOVE
    out['S Butter'] -= 50 * vegan; // VEGAN_REMOVE
    if (gf > 0) out['S GF Flour'] = 110 * gf;
    if (vegan > 0) out['S Vegan Block'] = 55 * vegan;
    return out;
  }

  it.each([
    [5, 0, 0],
    [5, 0, 2],
    [6, 2, 1],
    [10, 3, 4],
    [4, 4, 0],
  ])('covers=%i gf=%i vegan=%i', async (covers, gf, vegan) => {
    await mixedDietRecipe();
    const lines = await forSession(covers, gf, vegan);

    const totals: Record<string, number> = {};
    for (const l of lines) {
      totals[l.productName] = (totals[l.productName] ?? 0) + l.expectedQty;
    }
    // Drop the zero entries the old rule would also have produced as zero.
    const want = Object.fromEntries(
      Object.entries(merged(covers, gf, vegan)).filter(([, v]) => v > 0),
    );
    expect(totals).toEqual(want);
  });
});

describe('a removal that names no part', () => {
  it('removes the ingredient from EVERY part of the cake', async () => {
    // Every recipe imported before components existed has an empty component.
    // A strict product-AND-part match would make those variations silently
    // stop removing anything the day a recipe gained its first named part —
    // the ingredient would reappear in the diet's list and nothing would error.
    await recipeSvc.create({
      bake: CAKE,
      effectiveFrom: '2026-01-01',
      companyId: COMPANY,
      lines: [
        { productId: flour, qtyPerCover: 100, component: 'Cake' },
        { productId: icing, qtyPerCover: 20, component: 'Cake' },
        { productId: icing, qtyPerCover: 75, component: 'Topping' },
        // No component named — "no icing sugar for a vegan bench", full stop.
        { productId: icing, qtyPerCover: 0, variant: 'VEGAN_REMOVE' },
      ],
    });
    const lines = await forSession(3, 0, 1);

    const vegan = lines.filter((l) => l.section === 'VEGAN');
    expect(vegan.map((l) => l.productName)).toEqual(['S Flour']);
    // …while the regular benches still get both icing-sugar lines.
    expect(lines.filter((l) => l.section === 'REGULAR' && l.productName === 'S Icing Sugar'))
      .toHaveLength(2);
  });
});
