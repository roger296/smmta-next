-- Bake type + active flag on recipes (Sept-2026 user testing, items 2 and 3).
--
-- ITEM 2: "separate bakes into three groups 'Corporate', 'Regular' and 'Other'
-- with headers. The recipes will be tagged in the recipe definition page by
-- setting a 'Bake Type' field."
--
-- ITEM 3: "add a field that can be used to define each recipe as 'Active' or
-- 'Inactive'. Then update the list of bakes at the start of the end of bake
-- form so that it only shows 'Active' bakes — this will reduce clutter."
--
-- Both default so every existing recipe stays exactly as it behaves today: a
-- REGULAR bake that appears on the form. The alternative — defaulting to
-- inactive, or to no type — would empty the end-of-bake picker at the next
-- deploy, which is the same silence as the defects this release is fixing.
--
-- `bake_type` is a varchar with a CHECK rather than a pg enum: the three values
-- are a menu-planning convention, and widening a CHECK is a one-line migration
-- where widening an enum in a transaction is not.
ALTER TABLE "recipes"
  ADD COLUMN IF NOT EXISTS "bake_type" varchar(20) NOT NULL DEFAULT 'REGULAR',
  ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true;

ALTER TABLE "recipes"
  DROP CONSTRAINT IF EXISTS "recipes_bake_type_check";
ALTER TABLE "recipes"
  ADD CONSTRAINT "recipes_bake_type_check"
  CHECK ("bake_type" IN ('CORPORATE', 'REGULAR', 'OTHER'));

-- The end-of-bake picker asks "which cakes are live here today" on every load.
CREATE INDEX IF NOT EXISTS "recipes_active_idx"
  ON "recipes" ("company_id", "is_active");
