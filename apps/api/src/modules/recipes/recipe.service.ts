/**
 * RecipeService (P15, spec §A6).
 *
 * Maintains versioned, date-effective recipes per **cake** (`bake`, a free-form
 * menu item — NOT an experience package tier), with an optional per-site
 * override and ingredient lines. Creating a recipe allocates the next version
 * for its (bake, site) and seeds each line's `unitCost` from the product's
 * BumbleBee cost (`expected_next_cost`) and its `stockUom`, unless the caller
 * supplies them. The admin Recipes page drives these.
 */
import { and, asc, desc, eq, inArray, isNull, max } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { products, recipeLines, recipes } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

export type Recipe = typeof recipes.$inferSelect;
export type RecipeLine = typeof recipeLines.$inferSelect;

export interface RecipeLineInput {
  productId: string;
  /**
   * Which list this line belongs to. Defaults to BASE so every existing
   * caller keeps working.
   *
   * A *_REMOVE line takes an ingredient OUT of the standard recipe for that
   * diet, so its quantity carries no meaning and is stored as 0 — the whole
   * ingredient goes.
   */
  variant?: RecipeLineVariant;
  qtyPerCover: number | string;
  /** Optional — defaults to the product's stock_uom. */
  stockUom?: string;
  /** Optional — defaults to the product's expected_next_cost (BumbleBee cost). */
  unitCost?: number | string | null;
}

export const RECIPE_LINE_VARIANTS = [
  'BASE',
  'GF_REMOVE',
  'GF_ADD',
  'VEGAN_REMOVE',
  'VEGAN_ADD',
] as const;
export type RecipeLineVariant = (typeof RECIPE_LINE_VARIANTS)[number];

/** The variants that take an ingredient out rather than adding one. */
export const REMOVAL_VARIANTS: readonly RecipeLineVariant[] = ['GF_REMOVE', 'VEGAN_REMOVE'];

export interface CreateRecipeInput {
  /** The cake this recipe makes (e.g. "Victoria Sponge"). */
  bake: string;
  /** NULL ⇒ global recipe; a site id ⇒ per-site override. */
  siteId?: string | null;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo?: string | null;
  name?: string | null;
  notes?: string | null;
  lines: RecipeLineInput[];
  companyId?: string;
}

/**
 * An amendment to an existing version. `bake`, `siteId` and `version` are
 * absent on purpose — they identify the version, and superseding a recipe
 * means adding a new one rather than renaming this.
 */
export interface UpdateRecipeInput {
  effectiveFrom?: string;
  effectiveTo?: string | null;
  name?: string | null;
  notes?: string | null;
  /** When given, REPLACES the ingredient list wholesale. */
  lines?: RecipeLineInput[];
}

/** A recipe line with its product resolved — what the editor actually needs. */
export interface RecipeLineWithProduct extends RecipeLine {
  productName: string;
  productStockUom: string;
}

export class RecipeService {
  private db = getDb();

  /** Next version for a (bake, site) group; 1 if none exist yet.
   *  `siteId === null` scopes to the global recipes (siteId IS NULL). */
  private async nextVersion(
    bake: string,
    siteId: string | null,
    companyId: string,
  ): Promise<number> {
    const [row] = await this.db
      .select({ v: max(recipes.version) })
      .from(recipes)
      .where(
        and(
          eq(recipes.companyId, companyId),
          eq(recipes.bake, bake),
          siteId === null ? isNull(recipes.siteId) : eq(recipes.siteId, siteId),
        ),
      );
    return (row?.v ?? 0) + 1;
  }

  /** The product's stock_uom + BumbleBee cost, for seeding a line. */
  private async seedFromProduct(
    productId: string,
    companyId: string,
  ): Promise<{ stockUom: string; unitCost: string | null }> {
    const product = await this.db.query.products.findFirst({
      where: and(eq(products.id, productId), eq(products.companyId, companyId)),
      columns: { stockUom: true, expectedNextCost: true },
    });
    return {
      stockUom: product?.stockUom ?? 'each',
      unitCost: product?.expectedNextCost ?? null,
    };
  }

  /** Create a new recipe version with its lines (cost/uom seeded per line). */
  async create(input: CreateRecipeInput): Promise<{ recipe: Recipe; lines: RecipeLine[] }> {
    const companyId = input.companyId ?? getSingletonCompanyId();
    const siteId = input.siteId ?? null;
    const version = await this.nextVersion(input.bake, siteId, companyId);

    const [recipe] = await this.db
      .insert(recipes)
      .values({
        companyId,
        bake: input.bake,
        siteId,
        version,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        name: input.name ?? null,
        notes: input.notes ?? null,
      })
      .returning();

    const lines: RecipeLine[] = [];
    for (const line of input.lines) {
      const seed = await this.seedFromProduct(line.productId, companyId);
      const variant = line.variant ?? 'BASE';
      const [created] = await this.db
        .insert(recipeLines)
        .values({
          companyId,
          recipeId: recipe!.id,
          productId: line.productId,
          variant,
          // A removal takes the whole ingredient out, so its quantity is
          // meaningless — stored as 0 rather than left to whatever the form
          // happened to send.
          qtyPerCover: REMOVAL_VARIANTS.includes(variant) ? '0' : String(line.qtyPerCover),
          stockUom: line.stockUom ?? seed.stockUom,
          unitCost: line.unitCost != null ? String(line.unitCost) : seed.unitCost,
        })
        .returning();
      lines.push(created!);
    }
    return { recipe: recipe!, lines };
  }

  /**
   * Amend a recipe version in place.
   *
   * Safe to do, and worth saying why: `session_consumption_lines.expected_qty`
   * is SNAPSHOTTED at submit, so already-filed sessions keep the numbers they
   * were judged against. Editing changes what future sessions expect, not what
   * past ones were measured by.
   *
   * `bake`, `site` and `version` are deliberately NOT editable — they are the
   * version's identity, and the unique index is built on them. Superseding a
   * recipe means adding a version, not renaming one.
   */
  async update(
    id: string,
    input: UpdateRecipeInput,
    companyId = getSingletonCompanyId(),
  ): Promise<{ recipe: Recipe; lines: RecipeLine[] } | null> {
    const existing = await this.get(id, companyId);
    if (!existing) return null;

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.effectiveFrom !== undefined) patch.effectiveFrom = input.effectiveFrom;
    if (input.effectiveTo !== undefined) patch.effectiveTo = input.effectiveTo ?? null;
    if (input.name !== undefined) patch.name = input.name ?? null;
    if (input.notes !== undefined) patch.notes = input.notes ?? null;
    await this.db.update(recipes).set(patch).where(eq(recipes.id, id));

    if (input.lines) {
      // Replace wholesale rather than diff: a recipe is a short list, and a
      // partial update would leave removed ingredients silently consuming
      // stock on the next session.
      await this.db.delete(recipeLines).where(eq(recipeLines.recipeId, id));
      for (const line of input.lines) {
        const seed = await this.seedFromProduct(line.productId, companyId);
        const variant = line.variant ?? 'BASE';
        await this.db.insert(recipeLines).values({
          companyId,
          recipeId: id,
          productId: line.productId,
          variant,
          qtyPerCover: REMOVAL_VARIANTS.includes(variant) ? '0' : String(line.qtyPerCover),
          stockUom: line.stockUom ?? seed.stockUom,
          unitCost: line.unitCost != null ? String(line.unitCost) : seed.unitCost,
        });
      }
    }
    return this.get(id, companyId);
  }

  /**
   * Remove a recipe version. Its lines go with it via the cascade.
   *
   * Filed sessions are unaffected — they snapshotted their expected
   * quantities — so this removes a definition, not any history.
   */
  async remove(id: string, companyId = getSingletonCompanyId()): Promise<boolean> {
    const existing = await this.get(id, companyId);
    if (!existing) return false;
    await this.db.delete(recipeLines).where(eq(recipeLines.recipeId, id));
    await this.db.delete(recipes).where(eq(recipes.id, id));
    return true;
  }

  /**
   * A recipe and its lines, each line carrying its product's NAME.
   *
   * Resolved here rather than in the browser. The editor lists ingredients in
   * a "remove for gluten free" dropdown, and without a name the only thing it
   * can show is a fragment of the id — which is exactly what it did, and is
   * useless to whoever is editing the recipe.
   */
  async get(
    id: string,
    companyId = getSingletonCompanyId(),
  ): Promise<{ recipe: Recipe; lines: RecipeLineWithProduct[] } | null> {
    const recipe = await this.db.query.recipes.findFirst({
      where: and(eq(recipes.id, id), eq(recipes.companyId, companyId)),
    });
    if (!recipe) return null;
    const lines = await this.db
      .select()
      .from(recipeLines)
      .where(eq(recipeLines.recipeId, id))
      .orderBy(asc(recipeLines.createdAt));
    return { recipe, lines: await this.withProductNames(lines, companyId) };
  }

  /** Attach product names to lines in one query rather than N. */
  private async withProductNames(
    lines: RecipeLine[],
    companyId: string,
  ): Promise<RecipeLineWithProduct[]> {
    if (lines.length === 0) return [];
    const rows = await this.db
      .select({ id: products.id, name: products.name, stockUom: products.stockUom })
      .from(products)
      .where(
        and(
          eq(products.companyId, companyId),
          inArray(
            products.id,
            lines.map((l) => l.productId),
          ),
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return lines.map((l) => ({
      ...l,
      // A recipe can outlive its ingredient. Say so rather than print an id.
      productName: byId.get(l.productId)?.name ?? 'Deleted product',
      productStockUom: byId.get(l.productId)?.stockUom ?? l.stockUom,
    }));
  }

  /** All recipes (newest first), optionally filtered by cake / site. */
  async list(
    filter: { bake?: string; siteId?: string | null; companyId?: string } = {},
  ): Promise<Recipe[]> {
    const companyId = filter.companyId ?? getSingletonCompanyId();
    const where = [eq(recipes.companyId, companyId)];
    if (filter.bake) where.push(eq(recipes.bake, filter.bake));
    if (filter.siteId) where.push(eq(recipes.siteId, filter.siteId));
    return this.db.query.recipes.findMany({
      where: and(...where),
      orderBy: [desc(recipes.effectiveFrom), desc(recipes.version)],
    });
  }

  /** The distinct cakes that have a recipe (the menu) — for pickers. */
  async listBakes(companyId = getSingletonCompanyId()): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ bake: recipes.bake })
      .from(recipes)
      .where(eq(recipes.companyId, companyId))
      .orderBy(asc(recipes.bake));
    return rows.map((r) => r.bake);
  }
}
