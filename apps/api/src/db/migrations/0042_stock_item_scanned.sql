-- Scanning serial-tracked units onto an order at despatch (2026-09-21).
-- A business that tracks serial numbers must know which unit went to which
-- customer. The picker takes any unit off the shelf, so the unit allocated by
-- the system is rarely the one in the box: each serial-tracked unit is scanned
-- at despatch, the scanned unit takes the allocated one's place, and the order
-- cannot ship until every such unit has been scanned. NULL for every existing
-- row; products that are not serial-tracked are never scanned.
ALTER TABLE "stock_items" ADD COLUMN "scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stock_items" ADD COLUMN "scanned_by" uuid;