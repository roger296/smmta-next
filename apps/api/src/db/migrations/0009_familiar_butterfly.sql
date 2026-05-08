CREATE TYPE "public"."fulfilment_source" AS ENUM('WAREHOUSE', 'SUPPLIER');--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "fulfilment_source" "fulfilment_source" DEFAULT 'WAREHOUSE' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "supplier_id" uuid;