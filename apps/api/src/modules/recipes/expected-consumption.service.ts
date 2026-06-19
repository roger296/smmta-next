/**
 * ExpectedConsumptionService (P15, spec §A6).
 *
 * Given a session (site, date, cake, covers) it computes the expected
 * consumption per ingredient = Σ(qty_per_cover × covers), resolving the recipe
 * for that **cake** (`bake`) effective on the session date and letting a
 * per-site override beat the global. A session bakes one cake — everyone bakes
 * the same recipe — so the experience *package* a guest bought (Classic /
 * Sweeter / Ultimate) doesn't affect ingredients; it only affects the covers
 * count, which can be summed from the order lines' experience-booking products.
 */
import { and, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { products, recipeLines, recipes } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import type { Recipe, RecipeLine } from './recipe.service.js';

export interface ExpectedLine {
  productId: string;
  qtyPerCover: number;
  expectedQty: number;
  stockUom: string;
  unitCost: number | null;
  expectedCost: number | null;
}

/** A session order line as polled from BumbleBee — enough to sum covers. */
export interface SessionLine {
  productId?: string | null;
  bumblebeeProductId?: string | null;
  quantity: number;
}

export class ExpectedConsumptionService {
  private db = getDb();

  /**
   * The recipe for a cake effective on a date at a site. A per-site override
   * (siteId set) beats the global (siteId NULL); within the winning scope the
   * newest version effective on the date wins.
   */
  async getEffectiveRecipe(input: {
    bake: string;
    siteId: string;
    onDate: string; // YYYY-MM-DD
    companyId?: string;
  }): Promise<{ recipe: Recipe; lines: RecipeLine[] } | null> {
    const companyId = input.companyId ?? getSingletonCompanyId();
    const effectiveOn = and(
      lte(recipes.effectiveFrom, input.onDate),
      or(isNull(recipes.effectiveTo), gt(recipes.effectiveTo, input.onDate)),
    );
    const candidates = await this.db.query.recipes.findMany({
      where: and(
        eq(recipes.companyId, companyId),
        eq(recipes.bake, input.bake),
        or(isNull(recipes.siteId), eq(recipes.siteId, input.siteId)),
        effectiveOn,
      ),
    });
    if (candidates.length === 0) return null;

    // Per-site override beats global; then newest effectiveFrom, then version.
    const siteSpecific = candidates.filter((r) => r.siteId === input.siteId);
    const scope = siteSpecific.length ? siteSpecific : candidates.filter((r) => r.siteId === null);
    scope.sort((a, b) =>
      a.effectiveFrom === b.effectiveFrom
        ? b.version - a.version
        : a.effectiveFrom < b.effectiveFrom
          ? 1
          : -1,
    );
    const recipe = scope[0];
    if (!recipe) return null;
    const lines = await this.db
      .select()
      .from(recipeLines)
      .where(eq(recipeLines.recipeId, recipe.id));
    return { recipe, lines };
  }

  /** Expected consumption per ingredient for one session = recipe(cake) × covers. */
  async expectedForSession(input: {
    bake: string;
    siteId: string;
    covers: number;
    onDate: string;
    companyId?: string;
  }): Promise<ExpectedLine[]> {
    const found = await this.getEffectiveRecipe(input);
    if (!found) return [];
    return found.lines.map((l) => {
      const qtyPerCover = Number(l.qtyPerCover);
      const expectedQty = round4(qtyPerCover * input.covers);
      const unitCost = l.unitCost != null ? Number(l.unitCost) : null;
      return {
        productId: l.productId,
        qtyPerCover,
        expectedQty,
        stockUom: l.stockUom,
        unitCost,
        expectedCost: unitCost != null ? round4(expectedQty * unitCost) : null,
      };
    });
  }

  /**
   * Sum a session's covers (guest count) from its order lines: a line whose
   * product is a bookable experience package (`products.is_experience_booking`)
   * contributes `quantity` covers, regardless of which package tier it is.
   */
  async resolveCovers(lines: SessionLine[], companyId = getSingletonCompanyId()): Promise<number> {
    const byProductId = new Map<string, number>();
    const byBumblebeeId = new Map<string, number>();
    for (const line of lines) {
      if (line.productId) byProductId.set(line.productId, (byProductId.get(line.productId) ?? 0) + line.quantity);
      else if (line.bumblebeeProductId)
        byBumblebeeId.set(line.bumblebeeProductId, (byBumblebeeId.get(line.bumblebeeProductId) ?? 0) + line.quantity);
    }
    const ids = [...byProductId.keys()];
    const bbIds = [...byBumblebeeId.keys()];
    if (ids.length === 0 && bbIds.length === 0) return 0;
    const rows = await this.db.query.products.findMany({
      where: and(
        eq(products.companyId, companyId),
        eq(products.isExperienceBooking, true),
        or(
          ids.length ? inArray(products.id, ids) : undefined,
          bbIds.length ? inArray(products.bumblebeeProductId, bbIds) : undefined,
        ),
      ),
      columns: { id: true, bumblebeeProductId: true },
    });
    let covers = 0;
    for (const row of rows) {
      covers += (row.id ? byProductId.get(row.id) ?? 0 : 0)
        + (row.bumblebeeProductId ? byBumblebeeId.get(row.bumblebeeProductId) ?? 0 : 0);
    }
    return covers;
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
