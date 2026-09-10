CREATE TYPE "public"."shipping_label_status" AS ENUM('PENDING', 'CREATED', 'FAILED', 'DISABLED');--> statement-breakpoint
CREATE TABLE "shipping_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" varchar(30) DEFAULT 'SMOOTH_PARCEL' NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"status" "shipping_label_status" DEFAULT 'PENDING' NOT NULL,
	"provider_order_code" varchar(100),
	"tracking_number" varchar(100),
	"label_path" varchar(255),
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"request_payload" jsonb,
	"response_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "shipping_labels_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "customer_delivery_addresses" ADD COLUMN "phone" varchar(50);--> statement-breakpoint
ALTER TABLE "shipping_labels" ADD CONSTRAINT "shipping_labels_order_id_customer_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."customer_orders"("id") ON DELETE cascade ON UPDATE no action;