-- An order shipped with a label made outside this system (2026-09-21).
-- Some businesses send part of their post on a carrier account that no label
-- integration covers. The dispatcher types the courier and tracking number onto
-- the order instead, and that stands in for a bought label when it is shipped.
-- False for every existing order, which keeps today's behaviour.
ALTER TABLE "customer_orders" ADD COLUMN "own_label" boolean DEFAULT false NOT NULL;
