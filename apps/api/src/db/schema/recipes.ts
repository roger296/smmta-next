import {
  pgTable,
  varchar,
  uuid,
  numeric,
  integer,
  date,
  text,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pk, companyId, auditTimestamps } from './common.js';
import { products } from './products.js';
import { sites } from './sites.js';

// ============================================================
// Recipes / BOM (spec §A6) — what each cake (bake) consumes
// ------------------------------------------------------------
// A recipe defines, per cake (`bake`, a free-form menu item), the
// ingredient/packaging quantity consumed per cover (per guest, who bakes one
// cake), so expected consumption = recipe × covers (the
// ExpectedConsumptionService). Recipes are versioned + date-effective:
// a session on a given date resolves to the recipe effective then. A recipe
// with `siteId = NULL` is the global default; a row with `siteId` set is a
// per-site override (e.g. Dallas) that beats the global for that site.
// ============================================================

export const recipes = pgTable(
  'recipes',
  {
    id: pk(),
    companyId: companyId(),
    /** The cake this recipe makes (free-form menu item, e.g. "Victoria Sponge").
     *  The recipe IS the cake's definition; new cakes need no migration. */
    bake: varchar('bake', { length: 200 }).notNull(),
    /** NULL = global recipe; set = per-site override (beats the global). */
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'cascade' }),
    /** Monotonic per (bake, site). The newest version effective on a date wins;
     *  superseding a recipe means creating a new version. */
    version: integer('version').notNull().default(1),
    /** Inclusive YYYY-MM-DD the version takes effect. */
    effectiveFrom: date('effective_from').notNull(),
    /** Exclusive YYYY-MM-DD the version stops applying; NULL = open-ended. */
    effectiveTo: date('effective_to'),
    name: varchar('name', { length: 200 }),
    notes: text('notes'),
    ...auditTimestamps,
  },
  (t) => ({
    recipesLookupIdx: index('recipes_lookup_idx').on(t.companyId, t.bake, t.siteId),
    // Guards site-specific versions; global rows (siteId NULL) are version-
    // allocated by the service (Postgres treats NULLs as distinct here).
    recipesVersionUnq: uniqueIndex('recipes_company_bake_site_version_unq').on(
      t.companyId,
      t.bake,
      t.siteId,
      t.version,
    ),
  }),
);

export const recipeLines = pgTable(
  'recipe_lines',
  {
    id: pk(),
    companyId: companyId(),
    recipeId: uuid('recipe_id').notNull().references(() => recipes.id, { onDelete: 'cascade' }),
    /** An INGREDIENT / PACKAGING product consumed by this experience. */
    productId: uuid('product_id').notNull().references(() => products.id),
    /** Quantity consumed per cover, in `stockUom`. */
    qtyPerCover: numeric('qty_per_cover', { precision: 18, scale: 4 }).notNull(),
    /** Snapshot of the product's stock_uom the qty is expressed in. */
    stockUom: varchar('stock_uom', { length: 20 }).notNull(),
    /** Seeded from BumbleBee cost_price (products.expected_next_cost) at line
     *  create; admin-editable. NULL ⇒ fall back to the live product cost. */
    unitCost: numeric('unit_cost', { precision: 18, scale: 4 }),
    ...auditTimestamps,
  },
  (t) => ({
    recipeLinesRecipeProductUnq: uniqueIndex('recipe_lines_recipe_product_unq').on(
      t.recipeId,
      t.productId,
    ),
  }),
);

export const recipesRelations = relations(recipes, ({ one, many }) => ({
  site: one(sites, { fields: [recipes.siteId], references: [sites.id] }),
  lines: many(recipeLines),
}));

export const recipeLinesRelations = relations(recipeLines, ({ one }) => ({
  recipe: one(recipes, { fields: [recipeLines.recipeId], references: [recipes.id] }),
  product: one(products, { fields: [recipeLines.productId], references: [products.id] }),
}));
