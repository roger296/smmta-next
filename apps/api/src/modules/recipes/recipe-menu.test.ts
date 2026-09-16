/**
 * The end-of-bake cake picker (Sept-2026 user testing, items 2 and 3).
 *
 * ITEM 2: "separate bakes into three groups 'Corporate', 'Regular' and 'Other'
 *          with headers … tagged in the recipe definition page."
 * ITEM 3: "define each recipe as 'Active' or 'Inactive' … so that it only
 *          shows 'Active' bakes — this will reduce clutter."
 *
 * Both are about a list a head baker reads at the start of every session, so
 * the subtleties that matter are about VERSIONS: a cake has several recipe
 * versions superseding one another by date, and neither the group nor the
 * on-menu state can be decided by picking an arbitrary one.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import { recipeLines, recipes, products } from '../../db/schema/index.js';
import { RecipeService } from './recipe.service.js';

const COMPANY = 'c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c6c6';
const svc = new RecipeService();
let productId: string;

async function seedProduct(): Promise<string> {
  const db = getDb();
  const existing = await db.query.products.findFirst({
    where: eq(products.companyId, COMPANY),
  });
  if (existing) return existing.id;
  const [p] = await db
    .insert(products)
    .values({
      companyId: COMPANY,
      name: 'Menu Flour',
      slug: 'menu-flour',
      itemKind: 'INGREDIENT',
      stockUom: 'g',
    })
    .returning();
  return p!.id;
}

const make = (bake: string, opts: Partial<Parameters<typeof svc.create>[0]> = {}) =>
  svc.create({
    bake,
    effectiveFrom: '2026-01-01',
    lines: [{ productId, qtyPerCover: 100 }],
    companyId: COMPANY,
    ...opts,
  });

beforeEach(async () => {
  const db = getDb();
  await db.delete(recipeLines).where(eq(recipeLines.companyId, COMPANY));
  await db.delete(recipes).where(eq(recipes.companyId, COMPANY));
  productId = await seedProduct();
});

afterAll(async () => {
  // Clean up after ourselves, like every neighbouring suite. This one matters
  // more than most: the cakes below are named "Victoria Sponge" and
  // "Battenburg", which are two of the four names `purge-demo-bakes` deletes
  // BY NAME. Leaving them in the database makes a later suite's result depend
  // on whether this one ran first.
  const db = getDb();
  await db.delete(recipeLines).where(eq(recipeLines.companyId, COMPANY));
  await db.delete(recipes).where(eq(recipes.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await closeDatabase();
});

describe('item 2: bake type', () => {
  it('defaults to REGULAR, so every imported recipe keeps behaving as it does today', async () => {
    // Defaulting to anything else — or to nothing — would empty or reshuffle
    // the picker at the next deploy, which is the same silence as the defects
    // this release is fixing.
    const { recipe } = await make('Victoria Sponge');
    expect(recipe.bakeType).toBe('REGULAR');
    expect(recipe.isActive).toBe(true);
  });

  it('carries the type onto the menu listing', async () => {
    await make('Corporate Away Day', { bakeType: 'CORPORATE' });
    await make('Victoria Sponge');
    await make('Staff Experiment', { bakeType: 'OTHER' });

    const menu = await svc.listBakes({ companyId: COMPANY });
    expect(menu).toEqual([
      { bake: 'Corporate Away Day', bakeType: 'CORPORATE', isActive: true },
      { bake: 'Staff Experiment', bakeType: 'OTHER', isActive: true },
      { bake: 'Victoria Sponge', bakeType: 'REGULAR', isActive: true },
    ]);
  });

  it('takes the type from the NEWEST version', async () => {
    // A cake reclassified this spring is corporate now; last year's version
    // saying otherwise is history, not the current menu.
    await make('Battenburg', { effectiveFrom: '2025-01-01', bakeType: 'REGULAR' });
    await make('Battenburg', { effectiveFrom: '2026-06-01', bakeType: 'CORPORATE' });

    const menu = await svc.listBakes({ companyId: COMPANY });
    expect(menu).toEqual([{ bake: 'Battenburg', bakeType: 'CORPORATE', isActive: true }]);
  });

  it('rejects a type outside the three groups', async () => {
    // The CHECK constraint, not the type system — an importer or a stale
    // client can send anything.
    await expect(
      make('Nonsense', { bakeType: 'SEASONAL' as unknown as 'REGULAR' }),
    ).rejects.toThrow();
  });
});

describe('item 3: active / inactive', () => {
  it('hides an inactive cake from the venue picker', async () => {
    await make('Victoria Sponge');
    await make('Christmas Yule Log', { isActive: false });

    expect(await svc.listBakes({ companyId: COMPANY })).toEqual([
      { bake: 'Victoria Sponge', bakeType: 'REGULAR', isActive: true },
    ]);
  });

  it('still lists it for the admin page, which has to find it to switch it back on', async () => {
    await make('Christmas Yule Log', { isActive: false });

    expect(await svc.listBakes({ includeInactive: true, companyId: COMPANY })).toEqual([
      { bake: 'Christmas Yule Log', bakeType: 'REGULAR', isActive: false },
    ]);
  });

  it('keeps a cake on the menu while ANY version is active', async () => {
    // Versions supersede one another by date. Retiring last spring's version
    // must not take the cake off tonight's menu.
    await make('Battenburg', { effectiveFrom: '2025-01-01', isActive: false });
    await make('Battenburg', { effectiveFrom: '2026-06-01', isActive: true });

    expect(await svc.listBakes({ companyId: COMPANY })).toEqual([
      { bake: 'Battenburg', bakeType: 'REGULAR', isActive: true },
    ]);
  });

  it('drops the cake only when every version is retired', async () => {
    await make('Battenburg', { effectiveFrom: '2025-01-01', isActive: false });
    await make('Battenburg', { effectiveFrom: '2026-06-01', isActive: false });

    expect(await svc.listBakes({ companyId: COMPANY })).toEqual([]);
  });

  it('is a toggle, not a delete — filed sessions keep resolving', async () => {
    const { recipe } = await make('Christmas Yule Log');
    await svc.update(recipe.id, { isActive: false }, COMPANY);

    const still = await svc.get(recipe.id, COMPANY);
    expect(still?.recipe.isActive).toBe(false);
    expect(still?.lines).toHaveLength(1);
  });
});
