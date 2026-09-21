-- A serial number identifies one live unit of a product (2026-09-21).
-- Booking-in and stock adds now refuse a serial already on a live stock item of
-- the same product; this index is the backstop for two people doing it at once.
-- Compared without regard to case. Soft-deleted rows do not count.
--
-- The API will not start if a migration fails, so existing rows are made to fit
-- first rather than left to break the deploy:
--   1. a blank serial becomes NULL (it was never a serial);
--   2. where a serial is repeated within a product, the oldest row keeps it and
--      each later one has "-DUP-<n>" added, so nothing is lost and the repeats
--      are easy to find: serial_number LIKE '%-DUP-%'.
UPDATE "stock_items" SET "serial_number" = NULL WHERE "serial_number" IS NOT NULL AND btrim("serial_number") = '';
--> statement-breakpoint
WITH ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "company_id", "product_id", lower("serial_number")
    ORDER BY "created_at", "id"
  ) AS n
  FROM "stock_items"
  WHERE "serial_number" IS NOT NULL AND "deleted_at" IS NULL
)
UPDATE "stock_items" s
SET "serial_number" = left(s."serial_number", 88) || '-DUP-' || (ranked.n - 1)
FROM ranked
WHERE ranked."id" = s."id" AND ranked.n > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "stock_items_product_serial_unq" ON "stock_items" USING btree ("company_id","product_id",lower("serial_number")) WHERE "stock_items"."serial_number" IS NOT NULL AND "stock_items"."deleted_at" IS NULL;
