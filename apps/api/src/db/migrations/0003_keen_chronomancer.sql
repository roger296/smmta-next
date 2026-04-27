CREATE TYPE "public"."reservation_status" AS ENUM('HELD', 'RELEASED', 'CONVERTED', 'EXPIRED');--> statement-breakpoint
ALTER TYPE "public"."stock_item_status" ADD VALUE 'RESERVED' BEFORE 'ALLOCATED';--> statement-breakpoint
CREATE TABLE "stock_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_channel" "source_channel" DEFAULT 'API' NOT NULL,
	"status" "reservation_status" DEFAULT 'HELD' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "stock_items" ADD COLUMN "reservation_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_reservation_id_stock_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."stock_reservations"("id") ON DELETE no action ON UPDATE no action;