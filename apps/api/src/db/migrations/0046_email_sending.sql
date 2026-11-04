CREATE TABLE "email_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" varchar(64) NOT NULL,
	"message" text NOT NULL,
	"detail" jsonb,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_orders" ADD COLUMN "email_send_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD COLUMN "email_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_orders" ADD COLUMN "email_processed_at" timestamp with time zone;