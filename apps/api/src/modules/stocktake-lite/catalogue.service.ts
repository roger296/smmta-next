/**
 * The counting sheet, served from the product catalogue.
 *
 * This replaces the JSON blob the PWA used to bundle at build time. That blob
 * was generated from the June spreadsheet, so the sheet and the product
 * catalogue were two lists that drifted apart. Now there is one list and the
 * database is it.
 *
 * The shape is deliberately the same flat, ordered array the PWA already
 * groups by (area, section) — so the client keeps its existing grouping and
 * only changes where the array comes from.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { categories, products, productCategoryMappings } from '../../db/schema/index.js';

export interface CatalogueLine {
  /** Stable, SECTION-scoped id. A product counted in two places gets one key
   *  per place — keys must not collapse to the product, or the fondant counted
   *  in Creation Corner would overwrite the fondant counted in General
   *  Ingredients on sync and the conflict would never surface. */
  key: string;
  area: string | null;
  section: string | null;
  name: string;
  /** What the counter is counting in — kg, l, each, bottle. */
  uom: string;
  order: number;
}

const slugify = (s: string): string =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * A count line's stable id. Section-scoped ON PURPOSE: the same product is
 * counted in two places (every fondant colour is stocked in both General
 * Ingredients and Creation Corner), and a product-scoped key would make the
 * second count overwrite the first on sync — silently, since the consolidation
 * only flags a conflict when two *devices* touch the same key.
 *
 * Matches the key the bundled catalogue used, so counts already entered
 * against the old build still line up.
 */
export function countLineKey(section: string | null, productName: string): string {
  return `${slugify(section ?? '')}-${slugify(productName)}`;
}

export class CountCatalogueService {
  /**
   * Every count line, in walk order: area by `sortOrder`, then section by
   * `sortOrder`, then product name.
   */
  async list(companyId: string): Promise<CatalogueLine[]> {
    const db = getDb();

    // Sections are the child categories; their parent is the area.
    const areas = db
      .select({
        id: categories.id,
        name: categories.name,
        sortOrder: categories.sortOrder,
      })
      .from(categories)
      .where(and(eq(categories.companyId, companyId), isNull(categories.parentId)))
      .as('areas');

    const rows = await db
      .select({
        productName: products.name,
        uom: products.stockUom,
        section: categories.name,
        sectionOrder: categories.sortOrder,
        area: areas.name,
        areaOrder: areas.sortOrder,
      })
      .from(productCategoryMappings)
      .innerJoin(products, eq(productCategoryMappings.productId, products.id))
      .innerJoin(categories, eq(productCategoryMappings.categoryId, categories.id))
      .innerJoin(areas, eq(categories.parentId, areas.id))
      .where(eq(products.companyId, companyId))
      .orderBy(asc(areas.sortOrder), asc(categories.sortOrder), asc(products.name));

    return rows.map((r, i) => ({
      // Matches the key the bundled catalogue used (section slug + name slug),
      // so counts already entered against the old build still line up.
      key: countLineKey(r.section, r.productName),
      area: r.area,
      section: r.section,
      name: r.productName,
      uom: r.uom,
      order: i + 1,
    }));
  }
}
