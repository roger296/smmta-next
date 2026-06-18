CREATE TYPE "public"."stock_movement_type" AS ENUM('GRN', 'ADJUSTMENT', 'SALE', 'CONSUMPTION', 'WASTAGE', 'TRANSFER_IN', 'TRANSFER_OUT', 'STOCKTAKE_TRUE_UP', 'OPENING');--> statement-breakpoint
CREATE TYPE "public"."uom_system" AS ENUM('METRIC', 'IMPERIAL');--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"slug" varchar(80) NOT NULL,
	"name" varchar(200) NOT NULL,
	"canonical_name" varchar(200) NOT NULL,
	"currency_code" varchar(3) DEFAULT 'GBP' NOT NULL,
	"uom_system" "uom_system" DEFAULT 'METRIC' NOT NULL,
	"timezone" varchar(64) DEFAULT 'Europe/London' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"on_hand" numeric(18, 3) DEFAULT '0' NOT NULL,
	"allocated" numeric(18, 3) DEFAULT '0' NOT NULL,
	"reorder_point" numeric(18, 3),
	"reorder_up_to" numeric(18, 3),
	"min_days_cover" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"qty_delta" numeric(18, 3) NOT NULL,
	"movement_type" "stock_movement_type" NOT NULL,
	"source_system" varchar(60) NOT NULL,
	"source_key" varchar(200) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"unit_cost" numeric(18, 4),
	"currency_code" varchar(3) DEFAULT 'GBP' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sites_company_slug_unq" ON "sites" USING btree ("company_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_levels_company_product_site_unq" ON "stock_levels" USING btree ("company_id","product_id","site_id");--> statement-breakpoint
CREATE INDEX "stock_levels_site_idx" ON "stock_levels" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_source_unq" ON "stock_movements" USING btree ("source_system","source_key","content_hash");--> statement-breakpoint
CREATE INDEX "stock_movements_product_site_idx" ON "stock_movements" USING btree ("product_id","site_id");--> statement-breakpoint
CREATE INDEX "stock_movements_occurred_idx" ON "stock_movements" USING btree ("occurred_at");