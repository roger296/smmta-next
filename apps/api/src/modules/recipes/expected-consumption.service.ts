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

/**
 * NOTE ON UNITS: `covers` throughout this module is the number of TABLES the
 * session ran, entered by the session leader. Teams bake together, so tables
 * drive ingredient use rather than head count, and recipe quantities are
 * expressed per table. The name is historical.
 */
export interface ExpectedLine {
  productId: string;
  /**
   * The product's name, resolved server-side.
   *
   * The head-baker form used to look this up in the browser from a single
   * 500-row page of products, falling back to the first 8 characters of the
   * id. That quietly broke the moment the catalogue passed 500 products: the
   * form showed bakers a row of hex codes and asked them how much they'd used.
   * The server already has the product joined — it should just say.
   */
  productName: string;
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
  /**
   * What a session is expected to consume, given how its tables split.
   *
   * Every table bakes the cake, so the base recipe applies to ALL of them —
   * `covers` is the total table count. A gluten-free or vegan table then
   * deviates: some base ingredients come out, some substitutes go in.
   *
   *   expected(product) = base × totalTables
   *                     − base × glutenFreeTables   (if in GF_REMOVE)
   *                     − base × veganTables        (if in VEGAN_REMOVE)
   *                     + gfAdd × glutenFreeTables
   *                     + veganAdd × veganTables
   *
   * The reduction uses the BASE quantity, not the removal line's, because a
   * removal line carries no quantity — taking an ingredient out means taking
   * out however much that table would have used.
   */
  async expectedForSession(input: {
    bake: string;
    siteId: string;
    /** TOTAL tables — regular + gluten-free + vegan. */
    covers: number;
    onDate: string;
    glutenFreeTables?: number;
    veganTables?: number;
    companyId?: string;
  }): Promise<ExpectedLine[]> {
    const found = await this.getEffectiveRecipe(input);
    if (!found) return [];

    // BASE only. The GF/vegan lists describe what CHANGES for a guest on that
    // diet; counting them here would add the gluten-free flour to every
    // session on top of the ordinary flour, and quietly inflate both the
    // expected consumption and the materials cost.
    const baseLines = found.lines.filter((l) => (l.variant ?? 'BASE') === 'BASE');

    const names = new Map<string, string>(
      (
        await this.db
          .select({ id: products.id, name: products.name })
          .from(products)
          .where(
            and(
              eq(products.companyId, input.companyId ?? getSingletonCompanyId()),
              inArray(
                products.id,
                // ALL lines, not just base: a gluten-free substitute appears
                // in the output too, and without its name it would render as
                // "Unknown product" on the bake form.
                found.lines.map((l) => l.productId),
              ),
            ),
          )
      ).map((r) => [r.id, r.name]),
    );

    const gfTables = Math.max(0, input.glutenFreeTables ?? 0);
    const veganTables = Math.max(0, input.veganTables ?? 0);

    // Accumulate by product: a substitute may be something the base recipe
    // already uses, in which case the quantities add rather than making a
    // second line for the same ingredient.
    const totals = new Map<string, { qtyPerCover: number; expectedQty: number; line: (typeof baseLines)[number] }>();
    const add = (line: (typeof found.lines)[number], qty: number, perTable: number) => {
      const existing = totals.get(line.productId);
      if (existing) {
        existing.expectedQty += qty;
        existing.qtyPerCover += perTable;
        return;
      }
      totals.set(line.productId, { qtyPerCover: perTable, expectedQty: qty, line });
    };

    for (const l of baseLines) add(l, Number(l.qtyPerCover) * input.covers, Number(l.qtyPerCover));

    // Removals: the diet's tables do not use this ingredient at all.
    for (const l of found.lines) {
      const variant = l.variant ?? 'BASE';
      const tables = variant === 'GF_REMOVE' ? gfTables : variant === 'VEGAN_REMOVE' ? veganTables : 0;
      if (tables === 0) continue;
      const base = totals.get(l.productId);
      // Nothing to reduce if the "removed" ingredient is not in the base
      // recipe — that is a recipe-authoring mistake, not a reason to go
      // negative.
      if (!base) continue;
      base.expectedQty -= base.qtyPerCover * tables;
    }

    // Substitutes.
    for (const l of found.lines) {
      const variant = l.variant ?? 'BASE';
      const tables = variant === 'GF_ADD' ? gfTables : variant === 'VEGAN_ADD' ? veganTables : 0;
      if (tables === 0) continue;
      add(l, Number(l.qtyPerCover) * tables, Number(l.qtyPerCover));
    }

    return [...totals.values()].map(({ line: l, expectedQty: rawExpected, qtyPerCover }) => {
      // Floating-point subtraction can leave -0.0000000001; clamp so a fully
      // substituted ingredient reads as 0 rather than a negative expectation.
      const expectedQty = round4(Math.max(0, rawExpected));
      const unitCost = l.unitCost != null ? Number(l.unitCost) : null;
      return {
        productId: l.productId,
        // A recipe line can outlive its product; say so rather than print a
        // hex fragment nobody can act on.
        productName: names.get(l.productId) ?? 'Unknown product',
        // One table's worth — what the Table+ / Table− buttons step by.
        qtyPerCover: round4(qtyPerCover),
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
