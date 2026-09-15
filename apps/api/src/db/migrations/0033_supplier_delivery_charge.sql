-- Per-supplier delivery charge (Roger, 2026-09-15). Each supplier sends its
-- items in one parcel and charges us for it, so a storefront charges the
-- customer once per parcel: this amount (inc VAT) for the supplier's parcel,
-- however many items it holds. NULL = the storefront's standard delivery rate.
-- A basket with items from two suppliers pays both charges.
ALTER TABLE "suppliers" ADD COLUMN "delivery_charge_gbp" numeric(10, 2);
