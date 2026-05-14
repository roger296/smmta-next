import { eq, and, isNull, ilike, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { categories, productCategoryMappings, products } from '../../db/schema/index.js';

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

  /**
   * Hierarchical tree view + product counts per category.
   *
   * Used by the admin SPA's Categories page to show the operator the
   * shape of the taxonomy and how many products are currently
   * assigned to each leaf. Hidden categories (`uncategorised`) are
   * INCLUDED in this listing — the operator needs to see them so
   * they can spot products that need mapping-rule coverage.
   *
   * Two queries: one for the categories themselves, one for the
   * GROUP BY counts of products.category_id. The join is done in
   * memory which is fine at ~50 categories.
   */
  async tree(companyId: string): Promise<
    Array<{
      id: string;
      slug: string | null;
      name: string;
      description: string | null;
      isHidden: boolean;
      sortOrder: number;
      productCount: number;
      children: Array<{
        id: string;
        slug: string | null;
        name: string;
        productCount: number;
        sortOrder: number;
      }>;
    }>
  > {
    const allCats = await this.db.query.categories.findMany({
      where: and(eq(categories.companyId, companyId), isNull(categories.deletedAt)),
      orderBy: (c, { asc }) => [asc(c.sortOrder), asc(c.name)],
    });
    const counts = await this.db
      .select({
        categoryId: products.categoryId,
        n: sql<number>`count(*)::int`,
      })
      .from(products)
      .where(
        and(
          eq(products.companyId, companyId),
          isNull(products.deletedAt),
        ),
      )
      .groupBy(products.categoryId);
    const countMap = new Map<string, number>();
    for (const r of counts) {
      if (r.categoryId) countMap.set(r.categoryId, Number(r.n));
    }
    const tops = allCats.filter((c) => c.parentId === null);
    return tops.map((top) => {
      const children = allCats
        .filter((c) => c.parentId === top.id)
        .map((sub) => ({
          id: sub.id,
          slug: sub.slug,
          name: sub.name,
          productCount: countMap.get(sub.id) ?? 0,
          sortOrder: sub.sortOrder,
        }));
      // Top-tier count = its own products + every child's products.
      const directCount = countMap.get(top.id) ?? 0;
      const childCount = children.reduce((s, c) => s + c.productCount, 0);
      return {
        id: top.id,
        slug: top.slug,
        name: top.name,
        description: top.description,
        isHidden: top.isHidden,
        sortOrder: top.sortOrder,
        productCount: directCount + childCount,
        children,
      };
    });
  }
}
