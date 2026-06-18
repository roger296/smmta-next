CREATE TABLE "square_item_map" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"square_key" varchar(200) NOT NULL,
	"product_id" uuid NOT NULL,
	"auto_matched" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "square_unmapped_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"channel_slug" varchar(60) NOT NULL,
	"source_pk" varchar(200) NOT NULL,
	"source_line_ref" varchar(200) NOT NULL,
	"square_key" varchar(200),
	"site_ref" varchar(200),
	"qty" numeric(18, 3) NOT NULL,
	"reason" varchar(60) NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "square_item_map" ADD CONSTRAINT "square_item_map_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "square_item_map_company_key_unq" ON "square_item_map" USING btree ("company_id","square_key");--> statement-breakpoint
CREATE UNIQUE INDEX "square_unmapped_line_unq" ON "square_unmapped_lines" USING btree ("channel_slug","source_pk","source_line_ref");--> statement-breakpoint
CREATE INDEX "square_unmapped_resolved_idx" ON "square_unmapped_lines" USING btree ("resolved_at");