ALTER TABLE "product_groups" ADD COLUMN "slug" varchar(200);--> statement-breakpoint
ALTER TABLE "product_groups" ADD COLUMN "short_description" varchar(280);--> statement-breakpoint
ALTER TABLE "product_groups" ADD COLUMN "long_description" text;--> statement-breakpoint
ALTER TABLE "product_groups" ADD COLUMN "hero_image_url" varchar(500);--> statement-breakpoint
ALTER TABLE "product_groups" ADD COLUMN "gallery_image_urls" jsonb;--> statement-breakpoint
ALTER TABLE "product_groups" ADD COLUMN "seo_title" varchar(70);--> statement-breakpoint
ALTER TABLE "product_groups" ADD COLUMN "seo_description" varchar(160);--> statement-breakpoint
ALTER TABLE "product_groups" ADD COLUMN "seo_keywords" jsonb;--> statement-breakpoint
ALTER TABLE "product_groups" ADD COLUMN "is_published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_groups" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "colour" varchar(80);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "colour_hex" varchar(7);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "slug" varchar(200);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "short_description" varchar(280);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "long_description" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "hero_image_url" varchar(500);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "gallery_image_urls" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "seo_title" varchar(70);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "seo_description" varchar(160);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "seo_keywords" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "sort_order_in_group" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_group_id_product_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."product_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_groups_company_id_slug_unq" ON "product_groups" USING btree ("company_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "products_company_id_slug_unq" ON "products" USING btree ("company_id","slug");--> statement-breakpoint
CREATE INDEX "products_group_id_idx" ON "products" USING btree ("group_id");