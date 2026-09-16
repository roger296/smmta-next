/**
 * A bake with several lines for the same ingredient (Sept-2026, items 5 and 6).
 *
 * Until now a consumption record held at most one line per product, enforced by
 * a unique index. Splitting the form into per-diet sections, and letting a
 * recipe use icing sugar in both the cake and the topping, both break that
 * assumption — and the things that break QUIETLY when it goes wrong are the
 * stock ledger and the materials cost, neither of which errors when it is off.
 *
 * So these pin three properties:
 *
 *   1. Several lines for one product each post their OWN stock movement.
 *   2. The movement key for an ordinary line is UNCHANGED, so an amend to a
 *      session filed before this release still posts a delta rather than the
 *      whole quantity a second time.
 *   3. "What's left in the tub" is refused on a duplicated product rather than
 *      being derived twice from the same opening stock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDatabase, getDb } from '../../config/database.js';
import {
  products,
  recipeLines,
  recipes,
  sessionConsumption,
  sessionConsumptionLines,
  sites,
  stockLevels,
  stockMovements,
} from '../../db/schema/index.js';
import { RecipeService } from '../recipes/recipe.service.js';
import { SessionConsumptionService } from './session-consumption.service.js';

const COMPANY = 'b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b8b8';
const svc = new SessionConsumptionService();
const recipeSvc = new RecipeService();
const CAKE = 'Multi Sponge';

let siteId: string;
let icingId: string;
let flourId: string;

async function clearLedger(): Promise<void> {
  const db = getDb();
  await db.delete(sessionConsumptionLines).where(eq(sessionConsumptionLines.companyId, COMPANY));
  await db.delete(sessionConsumption).where(eq(sessionConsumption.companyId, COMPANY));
  await db.delete(stockMovements).where(eq(stockMovements.companyId, COMPANY));
  await db.delete(stockLevels).where(eq(stockLevels.companyId, COMPANY));
}

beforeAll(async () => {
  const db = getDb();
  await clearLedger();
  await db.delete(recipeLines).where(eq(recipeLines.companyId, COMPANY));
  await db.delete(recipes).where(eq(recipes.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));

  const [icing] = await db
    .insert(products)
    .values({
      companyId: COMPANY,
      name: 'M Icing Sugar',
      slug: 'm-icing',
      itemKind: 'INGREDIENT',
      stockUom: 'g',
      expectedNextCost: '0.01',
    })
    .returning();
  const [flour] = await db
    .insert(products)
    .values({
      companyId: COMPANY,
      name: 'M Flour',
      slug: 'm-flour',
      itemKind: 'INGREDIENT',
      stockUom: 'g',
      expectedNextCost: '0.02',
    })
    .returning();
  const [site] = await db
    .insert(sites)
    .values({ companyId: COMPANY, slug: 'm-site', name: 'M Site', canonicalName: 'M Site' })
    .returning();
  icingId = icing!.id;
  flourId = flour!.id;
  siteId = site!.id;

  // Icing sugar twice — in the cake and in the topping (item 6).
  await recipeSvc.create({
    bake: CAKE,
    effectiveFrom: '2026-01-01',
    companyId: COMPANY,
    lines: [
      { productId: flourId, qtyPerCover: 100, component: 'Cake' },
      { productId: icingId, qtyPerCover: 20, component: 'Cake' },
      { productId: icingId, qtyPerCover: 75, component: 'Topping' },
    ],
  });
});

beforeEach(async () => {
  await clearLedger();
  const db = getDb();
  for (const productId of [icingId, flourId]) {
    await db
      .insert(stockLevels)
      .values({ companyId: COMPANY, productId, siteId, onHand: '100000' });
  }
});

afterAll(async () => {
  const db = getDb();
  await clearLedger();
  await db.delete(recipeLines).where(eq(recipeLines.companyId, COMPANY));
  await db.delete(recipes).where(eq(recipes.companyId, COMPANY));
  await db.delete(products).where(eq(products.companyId, COMPANY));
  await db.delete(sites).where(eq(sites.companyId, COMPANY));
  await closeDatabase();
});

const base = {
  siteId: '',
  sessionDate: '2026-09-16',
  bakerName: 'Sam',
  bake: CAKE,
  covers: 4,
  companyId: COMPANY,
};

describe('several lines for one ingredient', () => {
  it('stores each part of the recipe as its own line', async () => {
    const { lines } = await svc.submit({
      ...base,
      siteId,
      sessionId: 'MULTI-1',
      lines: [
        { productId: flourId, component: 'Cake', actualQty: 400 },
        { productId: icingId, component: 'Cake', actualQty: 80 },
        { productId: icingId, component: 'Topping', actualQty: 300 },
      ],
    });

    const icingLines = lines
      .filter((l) => l.productId === icingId)
      .sort((a, b) => a.component.localeCompare(b.component));
    expect(icingLines).toHaveLength(2);
    expect(icingLines.map((l) => [l.component, Number(l.actualQty)])).toEqual([
      ['Cake', 80],
      ['Topping', 300],
    ]);
    // Each carries its OWN expectation, not the pair's total.
    expect(icingLines.map((l) => Number(l.expectedQty))).toEqual([80, 300]);
  });

  it('posts a separate stock movement per line, so neither overwrites the other', async () => {
    await svc.submit({
      ...base,
      siteId,
      sessionId: 'MULTI-2',
      lines: [
        { productId: icingId, component: 'Cake', actualQty: 80 },
        { productId: icingId, component: 'Topping', actualQty: 300 },
      ],
    });

    const moves = await getDb()
      .select()
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.companyId, COMPANY),
          eq(stockMovements.productId, icingId),
          eq(stockMovements.movementType, 'CONSUMPTION'),
        ),
      );
    expect(moves).toHaveLength(2);
    expect(moves.map((m) => Number(m.qtyDelta)).sort((a, b) => a - b)).toEqual([-300, -80]);
    // Both sides of the shelf come off: 380 g, not 300 or 80.
    const level = await getDb().query.stockLevels.findFirst({
      where: and(eq(stockLevels.productId, icingId), eq(stockLevels.siteId, siteId)),
    });
    expect(Number(level!.onHand)).toBe(100000 - 380);
  });

  it('leaves the movement key of an ORDINARY line byte-identical', async () => {
    // Continuity, not cosmetics. An amend finds what it already posted by this
    // key. If sections had changed the key for every line, the first amend of
    // any session filed before this release would have posted the whole
    // quantity a second time instead of the difference.
    await svc.submit({
      ...base,
      siteId,
      sessionId: 'MULTI-3',
      bake: null,
      covers: 0,
      lines: [{ productId: flourId, actualQty: 400 }],
    });

    const move = await getDb().query.stockMovements.findFirst({
      where: and(
        eq(stockMovements.companyId, COMPANY),
        eq(stockMovements.productId, flourId),
        eq(stockMovements.movementType, 'CONSUMPTION'),
      ),
    });
    expect(move!.sourceKey).toBe(`consumption:MULTI-3:${flourId}`);
  });

  it('amends each line independently', async () => {
    const submit = (cake: number, topping: number) =>
      svc.submit({
        ...base,
        siteId,
        sessionId: 'MULTI-4',
        lines: [
          { productId: icingId, component: 'Cake', actualQty: cake },
          { productId: icingId, component: 'Topping', actualQty: topping },
        ],
      });

    await submit(80, 300);
    await submit(80, 350); // only the topping changed

    const level = await getDb().query.stockLevels.findFirst({
      where: and(eq(stockLevels.productId, icingId), eq(stockLevels.siteId, siteId)),
    });
    // 430 total, not 380 + 430 — the amend posted the 50 g delta only.
    expect(Number(level!.onHand)).toBe(100000 - 430);
  });
});

describe("what's left in the tub, on a duplicated ingredient", () => {
  it('is refused rather than derived twice from the same opening stock', async () => {
    // "What's left" is a fact about the TUB. Applied to two lines it would
    // subtract the same opening stock twice over and silently double the usage.
    await expect(
      svc.submit({
        ...base,
        siteId,
        sessionId: 'MULTI-5',
        lines: [
          { productId: icingId, component: 'Cake', entryMode: 'REMAINING', remainingQty: 500 },
          { productId: icingId, component: 'Topping', entryMode: 'REMAINING', remainingQty: 500 },
        ],
      }),
    ).rejects.toThrow(/more than one line/i);
  });

  it('still allows it when the ingredient is on ONE line', async () => {
    const { lines } = await svc.submit({
      ...base,
      siteId,
      sessionId: 'MULTI-6',
      lines: [{ productId: flourId, component: 'Cake', entryMode: 'REMAINING', remainingQty: 99600 }],
    });
    expect(Number(lines[0]!.actualQty)).toBe(400);
  });

  it('refuses before writing anything — a rejected bake leaves no half-record', async () => {
    await expect(
      svc.submit({
        ...base,
        siteId,
        sessionId: 'MULTI-7',
        lines: [
          { productId: flourId, actualQty: 400 },
          { productId: icingId, component: 'Cake', entryMode: 'REMAINING', remainingQty: 500 },
          { productId: icingId, component: 'Topping', entryMode: 'REMAINING', remainingQty: 500 },
        ],
      }),
    ).rejects.toThrow();

    const record = await getDb().query.sessionConsumption.findFirst({
      where: and(
        eq(sessionConsumption.companyId, COMPANY),
        eq(sessionConsumption.sessionId, 'MULTI-7'),
      ),
    });
    expect(record).toBeUndefined();
  });
});
