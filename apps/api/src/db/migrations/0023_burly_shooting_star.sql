CREATE TYPE "public"."stock_take_scope" AS ENUM('FULL', 'CATEGORY', 'ZONE', 'ITEM', 'CYCLE');--> statement-breakpoint
CREATE TYPE "public"."stock_take_status" AS ENUM('OPEN', 'APPROVED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "stock_take_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stock_take_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"book_qty" numeric(18, 3) NOT NULL,
	"counted_qty" numeric(18, 3),
	"variance" numeric(18, 3),
	"count_idempotency_key" varchar(200),
	"photo_refs" jsonb,
	"counted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stock_takes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"scope" "stock_take_scope" DEFAULT 'FULL' NOT NULL,
	"scope_ref" varchar(200),
	"status" "stock_take_status" DEFAULT 'OPEN' NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "stock_take_lines" ADD CONSTRAINT "stock_take_lines_stock_take_id_stock_takes_id_fk" FOREIGN KEY ("stock_take_id") REFERENCES "public"."stock_takes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_take_lines" ADD CONSTRAINT "stock_take_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_takes" ADD CONSTRAINT "stock_takes_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_take_lines_take_product_unq" ON "stock_take_lines" USING btree ("stock_take_id","product_id");--> statement-breakpoint
CREATE INDEX "stock_takes_site_idx" ON "stock_takes" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "stock_takes_status_idx" ON "stock_takes" USING btree ("status");