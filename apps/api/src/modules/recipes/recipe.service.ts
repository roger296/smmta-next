/**
 * RecipeService (P15, spec §A6).
 *
 * Maintains versioned, date-effective recipes (per experience, with an optional
 * per-site override) and their ingredient lines. Creating a recipe allocates the
 * next version for its (experience, site) and seeds each line's `unitCost` from
 * the product's BumbleBee cost (`expected_next_cost`) and its `stockUom`, unless
 * the caller supplies them. The admin Recipes page drives these.
 */
import { and, asc, desc, eq, isNull, max } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { products, recipeLines, recipes } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

export type Recipe = typeof recipes.$inferSelect;
export type RecipeLine = typeof recipeLines.$inferSelect;
export type ExperienceType = 'CLASSIC' | 'SWEETER' | 'ULTIMATE';

export interface RecipeLineInput {
  productId: string;
  qtyPerCover: number | string;
  /** Optional — defaults to the product's stock_uom. */
  stockUom?: string;
  /** Optional — defaults to the product's expected_next_cost (BumbleBee cost). */
  unitCost?: number | string | null;
}

export interface CreateRecipeInput {
  experience: ExperienceType;
  /** NULL ⇒ global recipe; a site id ⇒ per-site override. */
  siteId?: string | null;
  effectiveFrom: string; // YYYY-MM-DD
  effectiveTo?: string | null;
  name?: string | null;
  notes?: string | null;
  lines: RecipeLineInput[];
  companyId?: string;
}

export class RecipeService {
  private db = getDb();

  /** Next version for an (experience, site) group; 1 if none exist yet.
   *  `siteId === null` scopes to the global recipes (siteId IS NULL). */
  private async nextVersion(
    experience: ExperienceType,
    siteId: string | null,
    companyId: string,
  ): Promise<number> {
    const [row] = await this.db
      .select({ v: max(recipes.version) })
      .from(recipes)
      .where(
        and(
          eq(recipes.companyId, companyId),
          eq(recipes.experience, experience),
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
    const version = await this.nextVersion(input.experience, siteId, companyId);

    const [recipe] = await this.db
      .insert(recipes)
      .values({
        companyId,
        experience: input.experience,
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
      const unitCost =
        line.unitCost != null ? String(line.unitCost) : seed.unitCost;
      const [created] = await this.db
        .insert(recipeLines)
        .values({
          companyId,
          recipeId: recipe!.id,
          productId: line.productId,
          qtyPerCover: String(line.qtyPerCover),
          stockUom: line.stockUom ?? seed.stockUom,
          unitCost,
        })
        .returning();
      lines.push(created!);
    }
    return { recipe: recipe!, lines };
  }

  async get(id: string, companyId = getSingletonCompanyId()): Promise<{ recipe: Recipe; lines: RecipeLine[] } | null> {
    const recipe = await this.db.query.recipes.findFirst({
      where: and(eq(recipes.id, id), eq(recipes.companyId, companyId)),
    });
    if (!recipe) return null;
    const lines = await this.db
      .select()
      .from(recipeLines)
      .where(eq(recipeLines.recipeId, id))
      .orderBy(asc(recipeLines.createdAt));
    return { recipe, lines };
  }

  /** All recipes (newest first), optionally filtered by experience / site. */
  async list(
    filter: { experience?: ExperienceType; siteId?: string | null; companyId?: string } = {},
  ): Promise<Recipe[]> {
    const companyId = filter.companyId ?? getSingletonCompanyId();
    const where = [eq(recipes.companyId, companyId)];
    if (filter.experience) where.push(eq(recipes.experience, filter.experience));
    if (filter.siteId) where.push(eq(recipes.siteId, filter.siteId));
    return this.db.query.recipes.findMany({
      where: and(...where),
      orderBy: [desc(recipes.effectiveFrom), desc(recipes.version)],
    });
  }
}
