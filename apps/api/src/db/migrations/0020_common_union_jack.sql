CREATE TYPE "public"."supplier_order_channel" AS ENUM('EMAIL_PO', 'API_CONNECTOR');--> statement-breakpoint
ALTER TABLE "supplier_products" ADD COLUMN "auto_place_override" boolean;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD COLUMN "supplier_purchase_uom" varchar(20);--> statement-breakpoint
ALTER TABLE "supplier_products" ADD COLUMN "supplier_pack_size" numeric(18, 3);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "order_channel" "supplier_order_channel" DEFAULT 'EMAIL_PO' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "order_email" varchar(200);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "auto_place" boolean DEFAULT false NOT NULL;