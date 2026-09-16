-- Recipe components and per-diet sections (Sept-2026 user testing, items 5, 6).
--
-- ITEM 6: "we should make it possible for a recipe to have multiple lines for
-- the same ingredients (for example where icing sugar is used in the cake and
-- then separately in the topping) these should also be listed separately in the
-- end of bake form."
--
-- ITEM 5: "When there are items on the vegan or GF recipe that are the same as
-- those on the regular recipe, we currently combine them onto one line in the
-- end of bake form, users found this confusing so please split the different
-- recipe sections into separate sections with headers. Even though this will
-- result in multiple lines for the same product."
--
-- Both say the same thing about identity: a line is no longer "the product".
-- It is "the product, in this part of the recipe, for these benches". The two
-- unique indexes below are the whole migration — everything else follows from
-- them.
--
-- `component` defaults to '' (unnamed — the cake itself), and `section`
-- defaults to REGULAR, so every existing row keeps the identity it has now and
-- no filed session changes shape.

-- ── Recipes ────────────────────────────────────────────────────────────────
ALTER TABLE "recipe_lines"
  ADD COLUMN IF NOT EXISTS "component" varchar(40) NOT NULL DEFAULT '';

-- (recipe, product, variant) rejected a second icing-sugar line for the
-- topping. The component is what tells the two apart.
DROP INDEX IF EXISTS "recipe_lines_recipe_product_variant_unq";
CREATE UNIQUE INDEX IF NOT EXISTS "recipe_lines_recipe_product_variant_component_unq"
  ON "recipe_lines" ("recipe_id", "product_id", "variant", "component");

-- ── Filed sessions ─────────────────────────────────────────────────────────
ALTER TABLE "session_consumption_lines"
  ADD COLUMN IF NOT EXISTS "section" varchar(16) NOT NULL DEFAULT 'REGULAR',
  ADD COLUMN IF NOT EXISTS "component" varchar(40) NOT NULL DEFAULT '';

ALTER TABLE "session_consumption_lines"
  DROP CONSTRAINT IF EXISTS "session_consumption_lines_section_check";
ALTER TABLE "session_consumption_lines"
  ADD CONSTRAINT "session_consumption_lines_section_check"
  CHECK ("section" IN ('REGULAR', 'GLUTEN_FREE', 'VEGAN'));

-- Same reasoning: one bake can now legitimately carry several lines for the
-- same ingredient — the regular benches' flour and the gluten-free benches'
-- flour are different questions with different answers.
DROP INDEX IF EXISTS "session_consumption_lines_consumption_product_unq";
CREATE UNIQUE INDEX IF NOT EXISTS "session_consumption_lines_consumption_product_section_unq"
  ON "session_consumption_lines" ("consumption_id", "product_id", "section", "component");
