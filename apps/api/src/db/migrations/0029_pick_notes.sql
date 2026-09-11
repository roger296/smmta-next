CREATE TYPE "public"."pick_note_status" AS ENUM('PENDING', 'CREATED', 'FAILED');--> statement-breakpoint
CREATE TABLE "pick_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"status" "pick_note_status" DEFAULT 'PENDING' NOT NULL,
	"file_path" varchar(255),
	"content_hash" varchar(64),
	"line_count" integer DEFAULT 0 NOT NULL,
	"unit_count" double precision DEFAULT 0 NOT NULL,
	"error_message" text,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "pick_notes_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
ALTER TABLE "pick_notes" ADD CONSTRAINT "pick_notes_order_id_customer_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."customer_orders"("id") ON DELETE cascade ON UPDATE no action;