CREATE TYPE "public"."item_kind" AS ENUM('MERCH', 'RETAIL', 'INGREDIENT', 'PACKAGING');--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "item_kind" "item_kind" DEFAULT 'RETAIL' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_sold" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_stocked" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "barcode" varchar(64);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "bumblebee_product_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "reference_image_url" varchar(500);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "image_capture_store" varchar(200);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "stock_uom" varchar(20) DEFAULT 'each' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "purchase_uom" varchar(20);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "purchase_pack_size" numeric(18, 3) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "purchase_to_stock_factor" numeric(18, 4) DEFAULT '1' NOT NULL;--> statement-breakpoint
CREATE INDEX "products_bumblebee_id_idx" ON "products" USING btree ("bumblebee_product_id");--> statement-breakpoint
CREATE INDEX "products_barcode_idx" ON "products" USING btree ("barcode");