CREATE TYPE "public"."channel_kind" AS ENUM('STOREFRONT', 'MARKETPLACE');--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(80) NOT NULL,
	"kind" "channel_kind" NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"is_offered" boolean DEFAULT true NOT NULL,
	"price_override_gbp" numeric(18, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "product_channels" ADD CONSTRAINT "product_channels_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_channels" ADD CONSTRAINT "product_channels_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_slug_unq" ON "channels" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "product_channels_product_channel_unq" ON "product_channels" USING btree ("product_id","channel_id");--> statement-breakpoint
INSERT INTO "channels" ("slug", "kind", "display_name", "is_active") VALUES
  ('filament-store', 'STOREFRONT',  'Filament Store',   true),
  ('amazon-uk',     'MARKETPLACE', 'Amazon UK',        true),
  ('ebay-uk',       'MARKETPLACE', 'eBay UK',          true),
  ('etsy-uk',       'MARKETPLACE', 'Etsy UK',          true),
  ('shopify',       'MARKETPLACE', 'Shopify',          true)
ON CONFLICT ("slug") DO NOTHING;