ALTER TABLE "product_groups" ADD COLUMN "attribute_axes" text[];--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "attributes" jsonb;