-- Item Category + Stock Check Instruction on products (Sept-2026 request).
--
-- WHY A TABLE AND NOT A PG ENUM
-- The field reads as an enum to the operator — one value per product, chosen
-- from a list — but the request is explicitly that head office can add a new
-- category from the UI. A Postgres enum cannot be extended without a migration
-- and a deploy, so a user-managed lookup table is the only shape that honours
-- both halves. Uniqueness is on lower(name) per company, so "Dry Stock" and
-- "dry stock" cannot both exist and split a category in two.
--
-- WHY NOT THE EXISTING `categories` TABLE
-- `categories` is already two things at once: the storefront taxonomy (assigned
-- by committed rules in category-mapping.ts, which REWRITE products.category_id
-- on every backfill) and the stock-take sheet's area/section structure (a
-- many-to-many via product_category_mappings, because 23 items are counted in
-- two places). A value the operator sets by hand must not live anywhere a rule
-- run can overwrite it, and it is one-per-product rather than many. Hence its
-- own table and its own column.
CREATE TABLE IF NOT EXISTS item_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  name varchar(100) NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- Case-insensitive uniqueness among LIVE rows only: a deleted category's name
-- must be reusable, or retiring "Dry Stock" would block ever creating it again.
CREATE UNIQUE INDEX IF NOT EXISTS item_categories_company_name_unq
  ON item_categories (company_id, lower(name))
  WHERE deleted_at IS NULL;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS item_category_id uuid REFERENCES item_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS products_item_category_id_idx ON products (item_category_id);

-- Free text, capped at 200 chars per the request: "check the date on the box",
-- "weigh, do not count", "back shelf behind the mixer".
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock_check_instruction varchar(200);
