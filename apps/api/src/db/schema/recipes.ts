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
  boolean,
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
    /**
     * How the bake is grouped on the end-of-bake picker (Sept-2026, item 2).
     *
     * CORPORATE / REGULAR / OTHER — a menu-planning convention, not a
     * behavioural one: nothing in the costing or stock maths reads it. It
     * exists because a flat alphabetical list of every cake made a head baker
     * hunt for theirs at the start of every session.
     *
     * A varchar with a CHECK rather than a pg enum, so widening the list later
     * is a one-line migration.
     */
    bakeType: varchar('bake_type', { length: 20 }).notNull().default('REGULAR'),
    /**
     * Whether this cake is currently on the menu (Sept-2026, item 3).
     *
     * Only active recipes reach the end-of-bake picker. Inactive is NOT a
     * delete: sessions already filed against the recipe keep resolving, and
     * re-activating a seasonal cake is a toggle rather than a re-import.
     */
    isActive: boolean('is_active').notNull().default(true),
    ...auditTimestamps,
  },
  (t) => ({
    recipesLookupIdx: index('recipes_lookup_idx').on(t.companyId, t.bake, t.siteId),
    recipesActiveIdx: index('recipes_active_idx').on(t.companyId, t.isActive),
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
    /**
     * Which list this line belongs to.
     *
     *   BASE          the recipe as normally baked
     *   GF_REMOVE     taken out to make the gluten-free version
     *   GF_ADD        put in instead
     *   VEGAN_REMOVE  taken out to make the vegan version
     *   VEGAN_ADD     put in instead
     *
     * A *_REMOVE line names a product that is in BASE, so the same product
     * legitimately appears twice on one recipe — which is why the unique index
     * below includes the variant.
     */
    variant: varchar('variant', { length: 16 }).notNull().default('BASE'),
    /**
     * Which part of the cake this line belongs to (Sept-2026, item 6).
     *
     * "we should make it possible for a recipe to have multiple lines for the
     *  same ingredients (for example where icing sugar is used in the cake and
     *  then separately in the topping)."
     *
     * Free text, offered from a fixed list in the editor (Cake / Filling /
     * Topping / Decoration) with an Other box for the odd case — so the common
     * words stay spelled one way across recipes and venues without boxing in
     * whoever writes the next recipe.
     *
     * '' means unnamed, which is what every line written before this was, and
     * what a single-part recipe still is. It renders as no sub-heading.
     */
    component: varchar('component', { length: 40 }).notNull().default(''),
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
    // (recipe, product) alone would reject a GF_REMOVE line for a product
    // already in BASE — which is exactly what a removal IS. And (recipe,
    // product, variant) rejected a second icing-sugar line for the topping,
    // which is what item 6 asked for; the component tells those apart.
    recipeLinesRecipeProductUnq: uniqueIndex(
      'recipe_lines_recipe_product_variant_component_unq',
    ).on(t.recipeId, t.productId, t.variant, t.component),
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
