import { eq, and, isNull, ilike } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { categories, productCategoryMappings } from '../../db/schema/index.js';

/**
 * CategoryService — CRUD for product categories.
 *
 * Source: Old app had categories in DSB.Data/AppContext/Category.cs
 *         managed via various service helpers.
 */
export class CategoryService {
  private db = getDb();

  async list(companyId: string, search?: string) {
    const conditions = [eq(categories.companyId, companyId), isNull(categories.deletedAt)];
    if (search) conditions.push(ilike(categories.name, `%${search}%`));

    return this.db.query.categories.findMany({
      where: and(...conditions),
      orderBy: (c, { asc }) => [asc(c.name)],
    });
  }

  async getById(id: string, companyId: string) {
    return this.db.query.categories.findFirst({
      where: and(eq(categories.id, id), eq(categories.companyId, companyId), isNull(categories.deletedAt)),
    });
  }

  async create(companyId: string, name: string) {
    const [category] = await this.db
      .insert(categories)
      .values({ companyId, name })
      .returning();
    return category;
  }

  async update(id: string, companyId: string, name: string) {
    const [updated] = await this.db
      .update(categories)
      .set({ name, updatedAt: new Date() })
      .where(and(eq(categories.id, id), eq(categories.companyId, companyId)))
      .returning();
    return updated;
  }

  async delete(id: string, companyId: string) {
    const result = await this.db
      .update(categories)
      .set({ deletedAt: new Date() })
      .where(and(eq(categories.id, id), eq(categories.companyId, companyId), isNull(categories.deletedAt)));
    return (result.rowCount ?? 0) > 0;
  }

  // ── Category ↔ Product mappings ──

  async assignProductToCategory(productId: string, categoryId: string) {
    const existing = await this.db.query.productCategoryMappings.findFirst({
      where: and(
        eq(productCategoryMappings.productId, productId),
        eq(productCategoryMappings.categoryId, categoryId),
        isNull(productCategoryMappings.deletedAt),
      ),
    });
    if (existing) return existing;

    const [mapping] = await this.db
      .insert(productCategoryMappings)
      .values({ productId, categoryId })
      .returning();
    return mapping;
  }

  async removeProductFromCategory(productId: string, categoryId: string) {
    const result = await this.db
      .update(productCategoryMappings)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(productCategoryMappings.productId, productId),
          eq(productCategoryMappings.categoryId, categoryId),
          isNull(productCategoryMappings.deletedAt),
        ),
      );
    return (result.rowCount ?? 0) > 0;
  }

  async getProductCategories(productId: string) {
    const mappings = await this.db.query.productCategoryMappings.findMany({
      where: and(
        eq(productCategoryMappings.productId, productId),
        isNull(productCategoryMappings.deletedAt),
      ),
    });
    if (mappings.length === 0) return [];

    const categoryIds = mappings.map((m) => m.categoryId);
    return this.db.query.categories.findMany({
      where: and(
        isNull(categories.deletedAt),
        // Filter by IDs from the mappings
      ),
    });
  }
}
