/**
 * Item categories — the operator's own classification of a stocked item.
 *
 * Reads as an enum on the product but is user-managed: head office adds a
 * category from the UI (Sept-2026 request), which a Postgres enum cannot do
 * without a migration.
 *
 * Matching is case-insensitive throughout, in both directions. The CSV import
 * resolves a category by the NAME in the spreadsheet, and somebody typing
 * "dry stock" next to an existing "Dry Stock" must land on the same row rather
 * than creating a second one that then splits the catalogue in two.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { itemCategories, products } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

export interface ItemCategoryRow {
  id: string;
  name: string;
  sortOrder: number;
  /** How many live products carry it — so the UI can warn before retiring one. */
  productCount: number;
}

export class ItemCategoryInUseError extends Error {
  constructor(
    readonly name: string,
    readonly productCount: number,
  ) {
    super(
      `"${name}" is still set on ${productCount} product${productCount === 1 ? '' : 's'}. ` +
        'Move them to another category first, or clear the category on those products.',
    );
    this.name = 'ItemCategoryInUseError';
  }
}

export class ItemCategoryService {
  private db = getDb();

  /**
   * Every live category with how many products carry it.
   *
   * A LEFT JOIN rather than a correlated subquery, deliberately. Drizzle
   * renders an interpolated column inside a `sql` template UNQUALIFIED, so
   * `where ${products.itemCategoryId} = ${itemCategories.id}` came out as
   * `where "item_category_id" = "id"` — both resolving against `products`,
   * comparing a product's category to its own id, always false. Every count
   * read 0 and nothing errored. The join names its own tables and cannot do
   * that; `count(products.id)` ignores the NULL row a category with no
   * products produces.
   */
  async list(companyId = getSingletonCompanyId()): Promise<ItemCategoryRow[]> {
    const rows = await this.db
      .select({
        id: itemCategories.id,
        name: itemCategories.name,
        sortOrder: itemCategories.sortOrder,
        productCount: sql<number>`count(${products.id})::int`,
      })
      .from(itemCategories)
      .leftJoin(
        products,
        and(eq(products.itemCategoryId, itemCategories.id), isNull(products.deletedAt)),
      )
      .where(and(eq(itemCategories.companyId, companyId), isNull(itemCategories.deletedAt)))
      .groupBy(itemCategories.id, itemCategories.name, itemCategories.sortOrder)
      .orderBy(asc(itemCategories.sortOrder), asc(itemCategories.name));
    return rows;
  }

  /** The live category with this name, case-insensitively, or undefined. */
  async findByName(name: string, companyId = getSingletonCompanyId()) {
    const [row] = await this.db
      .select()
      .from(itemCategories)
      .where(
        and(
          eq(itemCategories.companyId, companyId),
          isNull(itemCategories.deletedAt),
          sql`lower(${itemCategories.name}) = lower(${name.trim()})`,
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * Create, or return the existing one if the name is already taken.
   *
   * Idempotent on purpose: "Add category" pressed twice, or two people adding
   * "Packaging" at once, should not be an error the operator has to read — and
   * the partial unique index would otherwise throw on the race.
   */
  async create(
    name: string,
    companyId = getSingletonCompanyId(),
    sortOrder = 0,
  ): Promise<{ row: typeof itemCategories.$inferSelect; created: boolean }> {
    const trimmed = name.trim();
    const existing = await this.findByName(trimmed, companyId);
    if (existing) return { row: existing, created: false };

    try {
      const [row] = await this.db
        .insert(itemCategories)
        .values({ companyId, name: trimmed, sortOrder })
        .returning();
      return { row: row!, created: true };
    } catch (err) {
      // Lost the race against a concurrent insert — re-read rather than 500.
      const raced = await this.findByName(trimmed, companyId);
      if (raced) return { row: raced, created: false };
      throw err;
    }
  }

  async rename(id: string, name: string, companyId = getSingletonCompanyId()) {
    const [row] = await this.db
      .update(itemCategories)
      .set({ name: name.trim(), updatedAt: new Date() })
      .where(and(eq(itemCategories.id, id), eq(itemCategories.companyId, companyId)))
      .returning();
    return row;
  }

  /**
   * Soft-delete. Refuses while products still carry it, because the FK is
   * `on delete set null` — a silent delete would blank the category on every
   * one of them with nothing to undo it from.
   */
  async remove(id: string, companyId = getSingletonCompanyId()): Promise<boolean> {
    const [row] = await this.db
      .select({ id: itemCategories.id, name: itemCategories.name })
      .from(itemCategories)
      .where(
        and(
          eq(itemCategories.id, id),
          eq(itemCategories.companyId, companyId),
          isNull(itemCategories.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return false;

    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(products)
      .where(and(eq(products.itemCategoryId, id), isNull(products.deletedAt)));
    if (count > 0) throw new ItemCategoryInUseError(row.name, count);

    await this.db
      .update(itemCategories)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(itemCategories.id, id));
    return true;
  }
}
