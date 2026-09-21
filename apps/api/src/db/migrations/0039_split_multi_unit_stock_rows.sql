-- One stock row per unit (2026-09-21).
-- Booking in a purchase order for a product without serial numbers wrote ONE
-- stock_items row holding the whole quantity. Everything else (free stock,
-- allocation, reservations, shipping) counts a row as one unit, so 50 units
-- booked in were seen, allocated and sold as 1. Booking-in now writes a row per
-- unit; this splits the rows already written.
--
-- Only free stock is split: IN_STOCK, whole-number quantity above 1, tied to no
-- order or reservation. A multi-unit row already allocated or sold is left as it
-- is, because how many of its units the order was meant to take cannot be known
-- from the data.
INSERT INTO "stock_items" (
  "company_id", "product_id", "serial_number", "batch_id", "warehouse_id",
  "location_isle", "location_shelf", "location_bin", "quantity", "status",
  "booked_in_date", "booked_out_date", "purchase_order_id", "sales_order_id",
  "reservation_id", "value", "currency_code", "old_id", "created_at", "updated_at"
)
SELECT
  s."company_id", s."product_id", NULL, s."batch_id", s."warehouse_id",
  s."location_isle", s."location_shelf", s."location_bin", 1, s."status",
  s."booked_in_date", s."booked_out_date", s."purchase_order_id", NULL,
  NULL, s."value", s."currency_code", NULL, s."created_at", now()
FROM "stock_items" s
CROSS JOIN LATERAL generate_series(2, s."quantity"::int) AS extra(n)
WHERE s."status" = 'IN_STOCK'
  AND s."deleted_at" IS NULL
  AND s."sales_order_id" IS NULL
  AND s."reservation_id" IS NULL
  AND s."quantity" > 1
  AND s."quantity" = floor(s."quantity");
--> statement-breakpoint
UPDATE "stock_items"
SET "quantity" = 1, "updated_at" = now()
WHERE "status" = 'IN_STOCK'
  AND "deleted_at" IS NULL
  AND "sales_order_id" IS NULL
  AND "reservation_id" IS NULL
  AND "quantity" > 1
  AND "quantity" = floor("quantity");
