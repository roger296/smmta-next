CREATE TYPE "public"."image_capture_source" AS ENUM('REFERENCE', 'GOODS_IN', 'STOCK_TAKE', 'CONSUMPTION', 'SHELF');--> statement-breakpoint
CREATE TABLE "image_captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid,
	"site_id" uuid,
	"source" "image_capture_source" NOT NULL,
	"image_ref" varchar(1000) NOT NULL,
	"label" varchar(200),
	"source_ref" varchar(200),
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "image_captures" ADD CONSTRAINT "image_captures_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_captures" ADD CONSTRAINT "image_captures_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "image_captures_product_site_captured_idx" ON "image_captures" USING btree ("product_id","site_id","captured_at");--> statement-breakpoint
CREATE INDEX "image_captures_ref_idx" ON "image_captures" USING btree ("image_ref");