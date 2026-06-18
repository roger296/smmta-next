CREATE TABLE "stock_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"batch_code" varchar(100) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"use_by" date,
	"original_qty" numeric(18, 3) NOT NULL,
	"qty_remaining" numeric(18, 3) NOT NULL,
	"unit_cost" numeric(18, 4),
	"currency_code" varchar(3) DEFAULT 'GBP' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_batches_company_product_site_code_unq" ON "stock_batches" USING btree ("company_id","product_id","site_id","batch_code");--> statement-breakpoint
CREATE INDEX "stock_batches_fefo_idx" ON "stock_batches" USING btree ("product_id","site_id","use_by");