-- Standalone wastage (Sept-2026 user testing, item 7).
--
-- "We currently have a function to add wastage to each line of the recipe in the
--  end of bake form by clicking the triangles to the right of each line, please
--  take this wastage function out of the end of bake form and create a separate
--  Wastage form linked to by a new main menu item on the PWA where any items
--  from stock can be marked as wasted."
--
-- Wastage was a triangle on each ingredient row of the end-of-bake form, so it
-- could only be recorded for something a recipe expected, during a bake, by the
-- person filing that bake. A dropped case of eggs on a Tuesday morning had
-- nowhere to go.
--
-- Each row writes ONE WASTAGE stock movement. The ledger holds the quantity;
-- this table holds what a person needs to make sense of it later — the reason,
-- who said so, and optionally which bake it happened during. `stock_movements`
-- has no room for any of that.
--
-- The existing `session_consumption_lines.wastage_qty` / `.wastage_reason`
-- columns are LEFT IN PLACE. Bakes already filed carry real wastage in them,
-- and dropping the columns would delete that history to tidy up a form.
CREATE TABLE IF NOT EXISTS "wastage_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "site_id" uuid NOT NULL REFERENCES "sites"("id"),
  "product_id" uuid NOT NULL REFERENCES "products"("id"),
  "qty" numeric(18, 3) NOT NULL,
  "stock_uom" varchar(20) NOT NULL,
  "reason" varchar(200) NOT NULL,
  "note" text,
  "recorded_by" varchar(200),
  "session_id" varchar(200),
  "bake" varchar(200),
  "unit_cost" numeric(18, 4),
  "currency_code" varchar(3) DEFAULT 'GBP' NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "client_key" varchar(200) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);

-- A replayed offline submit finds its own row and stops, rather than wasting
-- the same stock twice.
CREATE UNIQUE INDEX IF NOT EXISTS "wastage_events_company_client_key_unq"
  ON "wastage_events" ("company_id", "client_key");
CREATE INDEX IF NOT EXISTS "wastage_events_site_occurred_idx"
  ON "wastage_events" ("site_id", "occurred_at");
