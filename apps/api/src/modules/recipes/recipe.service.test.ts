/**
 * Recipes / BOM (P15, spec §A6). Real Postgres, isolated company.
 *
 * Covers: expected = Σ(qty_per_cover × covers) per ingredient for a session's
 * cake; version/date-effective selection; a per-site override beats the global;
 * recipe-line unit cost is seeded from the product's BumbleBee cost; a session's
 * covers are summed from its experience-booking order lines.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { products, recipeLines, recipes, sites } from '../../db/schema/index.js';
import { RecipeService } from './recipe.service.js';
import { ExpectedConsumptionService } from './expected-consumption.service.js';

const COMPANY = 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5d5';
const recipeSvc = new RecipeService();
const expected = new ExpectedConsumptionService();

let siteId: string;
let dallasId: string;
let flourId: string;
let sugarId: string;
let classicPackageId: string; // a bookable experience package (not a cake)

const SPONGE = 'Victoria Sponge';
const BATTENBURG = 'Battenburg';

async function clearRecipes(): Promise<void> {
  const db = getDb();
  await db.delete(recipeLines).where(eq(recipeLines.companyId, COMPANY));
  await db.delete(recipes).where(eq(recipes.companyId, COMPANY));
}

beforeAll(async () => {
  const db = getDb();
  await clearRecipes();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));

  const [f] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'R Flour', slug: 'r-flour', itemKind: 'INGREDIENT', stockUom: 'g', expectedNextCost: '0.05' })
    .returning();
  const [s] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'R Sugar', slug: 'r-sugar', itemKind: 'INGREDIENT', stockUom: 'g', expectedNextCost: '0.02' })
    .returning();
  // A bookable experience *package* (a price tier, not a cake).
  const [c] = await db
    .insert(products)
    .values({ companyId: COMPANY, name: 'Classic Package', slug: 'r-classic', itemKind: 'RETAIL', isExperienceBooking: true })
    .returning();
  flourId = f!.id;
  sugarId = s!.id;
  classicPackageId = c!.id;

  const [site] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'r-site', name: 'R Site', canonicalName: 'R Site' })
    .returning();
  siteId = site!.id;
  const [dallas] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'r-dallas', name: 'R Dallas', canonicalName: 'R Dallas', currencyCode: 'USD', uomSystem: 'IMPERIAL' })
    .returning();
  dallasId = dallas!.id;
});

beforeEach(clearRecipes);

afterAll(async () => {
  const db = getDb();
  await clearRecipes();
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  await closeDatabase();
});

describe('cost seeding', () => {
  it('seeds recipe-line unit cost + uom from the product when omitted', async () => {
    const { lines } = await recipeSvc.create({
      bake: SPONGE,
      effectiveFrom: '2026-01-01',
      lines: [
        { productId: flourId, qtyPerCover: 100 }, // no unitCost → seeded 0.05
        { productId: sugarId, qtyPerCover: 50, unitCost: 0.09 }, // explicit cost wins
      ],
      companyId: COMPANY,
    });
    const flour = lines.find((l) => l.productId === flourId)!;
    const sugar = lines.find((l) => l.productId === sugarId)!;
    expect(Number(flour.unitCost)).toBe(0.05);
    expect(flour.stockUom).toBe('g');
    expect(Number(sugar.unitCost)).toBe(0.09);
  });
});

describe('expected consumption', () => {
  it('expected = Σ(qty_per_cover × covers) per ingredient for the session cake', async () => {
    await recipeSvc.create({
      bake: SPONGE,
      effectiveFrom: '2026-01-01',
      lines: [
        { productId: flourId, qtyPerCover: 100 },
        { productId: sugarId, qtyPerCover: 50 },
      ],
      companyId: COMPANY,
    });
    const lines = await expected.expectedForSession({
      bake: SPONGE,
      siteId,
      covers: 8,
      onDate: '2026-06-18',
      companyId: COMPANY,
    });
    const flour = lines.find((l) => l.productId === flourId)!;
    const sugar = lines.find((l) => l.productId === sugarId)!;
    expect(flour.expectedQty).toBe(800); // 100 × 8
    expect(sugar.expectedQty).toBe(400); // 50 × 8
    expect(flour.expectedCost).toBe(40); // 800 × 0.05
  });

  it('sums covers from the experience-booking order lines (any package tier)', async () => {
    // 8 guests booked the Classic package → 8 covers, regardless of tier.
    const covers = await expected.resolveCovers([{ productId: classicPackageId, quantity: 8 }], COMPANY);
    expect(covers).toBe(8);
  });
});

describe('versioning / date-effective + per-site override', () => {
  it('picks the version effective on the session date', async () => {
    await recipeSvc.create({
      bake: SPONGE,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-06-01',
      lines: [{ productId: flourId, qtyPerCover: 100 }],
      companyId: COMPANY,
    });
    await recipeSvc.create({
      bake: SPONGE,
      effectiveFrom: '2026-06-01',
      lines: [{ productId: flourId, qtyPerCover: 120 }],
      companyId: COMPANY,
    });

    const may = await expected.expectedForSession({ bake: SPONGE, siteId, covers: 1, onDate: '2026-05-15', companyId: COMPANY });
    const june = await expected.expectedForSession({ bake: SPONGE, siteId, covers: 1, onDate: '2026-06-18', companyId: COMPANY });
    expect(may[0]!.qtyPerCover).toBe(100);
    expect(june[0]!.qtyPerCover).toBe(120);
  });

  it('a per-site override beats the global recipe for that site', async () => {
    await recipeSvc.create({
      bake: BATTENBURG,
      effectiveFrom: '2026-01-01',
      lines: [{ productId: flourId, qtyPerCover: 100 }],
      companyId: COMPANY,
    });
    // Dallas override — imperial recipe uses a different per-cover quantity.
    await recipeSvc.create({
      bake: BATTENBURG,
      siteId: dallasId,
      effectiveFrom: '2026-01-01',
      lines: [{ productId: flourId, qtyPerCover: 3.5 }],
      companyId: COMPANY,
    });

    const uk = await expected.expectedForSession({ bake: BATTENBURG, siteId, covers: 1, onDate: '2026-06-18', companyId: COMPANY });
    const dallas = await expected.expectedForSession({ bake: BATTENBURG, siteId: dallasId, covers: 1, onDate: '2026-06-18', companyId: COMPANY });
    expect(uk[0]!.qtyPerCover).toBe(100); // global
    expect(dallas[0]!.qtyPerCover).toBe(3.5); // override
  });
});
