-- The maker's brand, e.g. "AWDis Just Hoods" or "Uneek Clothing" (2026-09-17).
-- Google Merchant Centre needs a brand alongside a barcode or part number for
-- clothing, and both suppliers give us one: Ralawise in its CSV "Brand" column,
-- Uneek in its product data. NULL where the supplier states none.
ALTER TABLE "products" ADD COLUMN "brand" varchar(120);
