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
/**
 * A named reason a bake cannot be filed (Aug-2026 feedback set, F-5 / F-6).
 * The bake screen renders these as a blocking notice rather than presenting an
 * empty ingredient list that looks like a valid answer.
 */
export interface ExpectedBlocker {
  kind: 'NO_RECIPE' | 'NO_GF_VARIANT' | 'NO_VEGAN_VARIANT' | 'NO_INGREDIENTS';
  message: string;
}

/**
 * Which benches a line is answering for (Sept-2026 user testing, item 5).
 *
 * "When there are items on the vegan or GF recipe that are the same as those on
 *  the regular recipe, we currently combine them onto one line in the end of
 *  bake form, users found this confusing so please split the different recipe
 *  sections into separate sections with headers. Even though this will result
 *  in multiple lines for the same product."
 */
export const CONSUMPTION_SECTIONS = ['REGULAR', 'GLUTEN_FREE', 'VEGAN'] as const;
export type ConsumptionSection = (typeof CONSUMPTION_SECTIONS)[number];

export const SECTION_LABELS: Record<ConsumptionSection, string> = {
  REGULAR: 'Regular',
  GLUTEN_FREE: 'Gluten free',
  VEGAN: 'Vegan',
};

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
  /**
   * Which benches this figure is for (item 5). Each section carries the FULL
   * list those benches use, not the differences from the regular recipe — a
   * baker working a vegan bench needs their whole list in one place. The
   * section totals still sum to exactly what the old merged line said.
   */
  section: ConsumptionSection;
  /** How many benches this section's figure covers. */
  benches: number;
  /** Which part of the cake (item 6). '' = unnamed. */
  component: string;
}

/**
 * The stable identity of a line, now that "the product" is no longer enough.
 *
 * Used as the React key, as the submit payload's discriminator, and — via
 * `movementSuffix` below — as part of the stock-movement idempotency key.
 */
export function lineKey(l: {
  productId: string;
  section: ConsumptionSection;
  component: string;
}): string {
  return `${l.section}|${l.component}|${l.productId}`;
}

/**
 * What to append to a movement's `sourceKey` to tell two lines for the same
 * product apart.
 *
 * DELIBERATELY EMPTY for the ordinary case (regular benches, unnamed part), so
 * every movement key written before this change stays byte-identical. Those
 * keys are how an amend finds what it already posted; changing them for
 * existing sessions would make the next amend post the whole quantity again
 * instead of the delta.
 */
export function movementSuffix(l: { section: ConsumptionSection; component: string }): string {
  if (l.section === 'REGULAR' && !l.component) return '';
  return `:${l.section}${l.component ? `#${l.component}` : ''}`;
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
  /**
   * Expected consumption PLUS the reasons a bake cannot be filed (Aug-2026
   * feedback set, F-5 / F-6).
   *
   * "Selecting Vegan or GF options for Battenburg failed to generate required
   *  ingredients." — the variant machinery is correct, but every seeded line
   *  was BASE, so selecting GF silently returned the standard recipe.
   * "No bake logs were submitted due to incorrect recipe data." — a missing
   *  recipe produced an empty list and a transient toast.
   *
   * Both surfaced as *nothing happening*. This returns the same lines plus
   * named blockers, so the screen can refuse rather than present an empty form
   * that looks like a valid answer.
   */
  async expectedForSessionWithCoverage(input: {
    bake: string;
    siteId: string;
    covers: number;
    onDate: string;
    glutenFreeTables?: number;
    veganTables?: number;
    companyId?: string;
  }): Promise<{ lines: ExpectedLine[]; blockers: ExpectedBlocker[] }> {
    const found = await this.getEffectiveRecipe(input);
    const blockers: ExpectedBlocker[] = [];

    if (!found) {
      return {
        lines: [],
        blockers: [
          {
            kind: 'NO_RECIPE',
            message: `No recipe for "${input.bake}" on ${input.onDate} at this site. A bake cannot be filed against a recipe that does not exist.`,
          },
        ],
      };
    }

    const variants = new Set(found.lines.map((l) => l.variant ?? 'BASE'));
    const gfTables = Math.max(0, input.glutenFreeTables ?? 0);
    const veganTables = Math.max(0, input.veganTables ?? 0);

    // F-5: tables booked for a diet the recipe has nothing to say about. The
    // old behaviour returned base-only and looked like it had worked.
    if (gfTables > 0 && !variants.has('GF_REMOVE') && !variants.has('GF_ADD')) {
      blockers.push({
        kind: 'NO_GF_VARIANT',
        message: `"${input.bake}" has no gluten-free recipe, so ${gfTables} gluten-free table(s) would silently get the standard ingredients. Ask head office for the GF variation.`,
      });
    }
    if (veganTables > 0 && !variants.has('VEGAN_REMOVE') && !variants.has('VEGAN_ADD')) {
      blockers.push({
        kind: 'NO_VEGAN_VARIANT',
        message: `"${input.bake}" has no vegan recipe, so ${veganTables} vegan table(s) would silently get the standard ingredients. Ask head office for the vegan variation.`,
      });
    }

    const lines = await this.expectedForSession(input);
    if (lines.length === 0) {
      blockers.push({
        kind: 'NO_INGREDIENTS',
        message: `The recipe for "${input.bake}" produced no ingredients. A bake with an empty ingredient list cannot be filed.`,
      });
    }

    return { lines, blockers };
  }

  /** Which diets this bake actually has a recipe for (F-5's UI half). */
  async dietaryCoverage(input: {
    bake: string;
    siteId: string;
    onDate: string;
    companyId?: string;
  }): Promise<{ hasRecipe: boolean; glutenFree: boolean; vegan: boolean }> {
    const found = await this.getEffectiveRecipe(input);
    if (!found) return { hasRecipe: false, glutenFree: false, vegan: false };
    const variants = new Set(found.lines.map((l) => l.variant ?? 'BASE'));
    return {
      hasRecipe: true,
      glutenFree: variants.has('GF_REMOVE') || variants.has('GF_ADD'),
      vegan: variants.has('VEGAN_REMOVE') || variants.has('VEGAN_ADD'),
    };
  }

  /**
   * What each group of benches is expected to consume, as SEPARATE SECTIONS.
   *
   * ── Item 5 (Sept-2026 user testing) ────────────────────────────────────────
   * "When there are items on the vegan or GF recipe that are the same as those
   *  on the regular recipe, we currently combine them onto one line in the end
   *  of bake form, users found this confusing so please split the different
   *  recipe sections into separate sections with headers. Even though this will
   *  result in multiple lines for the same product."
   *
   * Recipes store the diets as DIFFERENCES from the base (take X out, put Y
   * in). Each section here carries the FULL list its benches use, resolved from
   * those differences — a baker working a vegan bench needs their whole list in
   * one place, not a list of swaps they have to apply in their head.
   *
   *   REGULAR      base × (covers − gf − vegan)
   *   GLUTEN_FREE  (base minus GF_REMOVE, plus GF_ADD) × gf
   *   VEGAN        (base minus VEGAN_REMOVE, plus VEGAN_ADD) × vegan
   *
   * ⚠️ THE SECTION TOTALS STILL SUM TO THE OLD MERGED FIGURE. This is a change
   * to how the question is asked, not to the arithmetic, and
   * `dietary-expected.test.ts` holds that identity. It has to: the same numbers
   * drive stock movements and the materials cost, and a split that quietly
   * shifted them would misstate every bake from the day it shipped.
   *
   * A section with no benches is omitted — an all-regular evening should not
   * make a baker scroll past two empty headings.
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

    const companyId = input.companyId ?? getSingletonCompanyId();
    const names = new Map<string, string>(
      (
        await this.db
          .select({ id: products.id, name: products.name })
          .from(products)
          .where(
            and(
              eq(products.companyId, companyId),
              // ALL lines, not just base: a gluten-free substitute appears in
              // the output too, and without its name it would render as
              // "Unknown product" on the bake form.
              inArray(
                products.id,
                found.lines.map((l) => l.productId),
              ),
            ),
          )
      ).map((r) => [r.id, r.name]),
    );

    const gfBenches = Math.max(0, input.glutenFreeTables ?? 0);
    const veganBenches = Math.max(0, input.veganTables ?? 0);
    // Regular is what is left over. Clamped at zero: a leader who types more
    // diet benches than total benches has made a typing mistake, and a
    // negative regular section would silently subtract from the bake.
    const regularBenches = Math.max(0, input.covers - gfBenches - veganBenches);

    const variantOf = (l: (typeof found.lines)[number]) => l.variant ?? 'BASE';
    const baseLines = found.lines.filter((l) => variantOf(l) === 'BASE');

    /**
     * One section's full ingredient list.
     *
     * ── HOW A REMOVAL MATCHES (item 6) ────────────────────────────────────
     * A removal line names a product and, optionally, a part of the cake:
     *
     *   component NAMED ("Topping")  → removes that part's line only. Taking
     *       the icing sugar out of the topping leaves the icing sugar inside
     *       the cake exactly where it is.
     *   component EMPTY              → removes the product from EVERY part.
     *
     * The empty case is not laziness, it is what the recipes already in the
     * database mean. Every line imported before components existed has an empty
     * component, so a strict product-AND-part match would have made every
     * existing gluten-free and vegan variation silently stop removing anything
     * the day a recipe gained its first named part — the ingredient would go
     * back into the diet's list and nothing would error.
     */
    const section = (
      sectionName: ConsumptionSection,
      benches: number,
      removeVariant: string | null,
      addVariant: string | null,
    ): ExpectedLine[] => {
      if (benches <= 0) return [];
      const removals = found.lines.filter(
        (l) => removeVariant !== null && variantOf(l) === removeVariant,
      );
      const removedEverywhere = new Set(
        removals.filter((l) => !(l.component ?? '')).map((l) => l.productId),
      );
      const removedInPart = new Set(
        removals
          .filter((l) => !!(l.component ?? ''))
          .map((l) => `${l.productId}|${l.component ?? ''}`),
      );
      const kept = baseLines.filter(
        (l) =>
          !removedEverywhere.has(l.productId) &&
          !removedInPart.has(`${l.productId}|${l.component ?? ''}`),
      );
      const added = found.lines.filter((l) => addVariant !== null && variantOf(l) === addVariant);
      return [...kept, ...added].map((l) => toLine(l, sectionName, benches, names));
    };

    return [
      ...section('REGULAR', regularBenches, null, null),
      ...section('GLUTEN_FREE', gfBenches, 'GF_REMOVE', 'GF_ADD'),
      ...section('VEGAN', veganBenches, 'VEGAN_REMOVE', 'VEGAN_ADD'),
    ];
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

/** One recipe line as a section's expected figure. */
function toLine(
  l: { productId: string; qtyPerCover: unknown; stockUom: string; unitCost: unknown; component?: string | null },
  section: ConsumptionSection,
  benches: number,
  names: Map<string, string>,
): ExpectedLine {
  const qtyPerBench = Number(l.qtyPerCover);
  const expectedQty = round4(Math.max(0, qtyPerBench * benches));
  const unitCost = l.unitCost != null ? Number(l.unitCost) : null;
  return {
    productId: l.productId,
    // A recipe line can outlive its product; say so rather than print a hex
    // fragment nobody can act on.
    productName: names.get(l.productId) ?? 'Unknown product',
    // One bench's worth — what the Bench± steps move by.
    qtyPerCover: round4(qtyPerBench),
    expectedQty,
    stockUom: l.stockUom,
    unitCost,
    expectedCost: unitCost != null ? round4(expectedQty * unitCost) : null,
    section,
    benches,
    component: l.component ?? '',
  };
}
