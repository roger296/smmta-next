CREATE TYPE "public"."checkout_status" AS ENUM('OPEN', 'RESERVED', 'PAYING', 'COMMITTED', 'FAILED', 'ABANDONED');--> statement-breakpoint
CREATE TYPE "public"."email_send_status" AS ENUM('PENDING', 'SENT', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."mollie_status" AS ENUM('open', 'pending', 'authorized', 'paid', 'canceled', 'expired', 'failed', 'refunded', 'partially_refunded');--> statement-breakpoint
CREATE TYPE "public"."webhook_source" AS ENUM('mollie', 'sendgrid');--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"price_snapshot_gbp" numeric(18, 2) NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"currency_code" varchar(3) DEFAULT 'GBP' NOT NULL,
	"totals_cache_gbp" numeric(18, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" uuid,
	"status" "checkout_status" DEFAULT 'OPEN' NOT NULL,
	"reservation_id" uuid,
	"mollie_payment_id" varchar(100),
	"idempotency_key" varchar(200),
	"smmta_order_id" uuid,
	"customer" jsonb,
	"delivery_address" jsonb,
	"invoice_address" jsonb,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to_email" varchar(200) NOT NULL,
	"template" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"send_status" "email_send_status" DEFAULT 'PENDING' NOT NULL,
	"sent_at" timestamp with time zone,
	"error" text,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" varchar(200) NOT NULL,
	"scope" varchar(100) NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mollie_payments" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"checkout_id" uuid NOT NULL,
	"amount_gbp" numeric(18, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'GBP' NOT NULL,
	"method" varchar(50),
	"status" "mollie_status" DEFAULT 'open' NOT NULL,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mollie_refunds" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"payment_id" varchar(100) NOT NULL,
	"smmta_credit_note_id" uuid,
	"amount_gbp" numeric(18, 2) NOT NULL,
	"status" varchar(50) NOT NULL,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "webhook_source" NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_body" text NOT NULL,
	"signature_ok" boolean DEFAULT false NOT NULL,
	"fetched_payment_status" varchar(50),
	"action_taken" text,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mollie_payments" ADD CONSTRAINT "mollie_payments_checkout_id_checkouts_id_fk" FOREIGN KEY ("checkout_id") REFERENCES "public"."checkouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mollie_refunds" ADD CONSTRAINT "mollie_refunds_payment_id_mollie_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."mollie_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cart_items_cart_id_idx" ON "cart_items" USING btree ("cart_id");--> statement-breakpoint
CREATE INDEX "checkouts_cart_id_idx" ON "checkouts" USING btree ("cart_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkouts_mollie_payment_id_unq" ON "checkouts" USING btree ("mollie_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_order_template_unq" ON "email_outbox" USING btree ("order_id","template");--> statement-breakpoint
CREATE INDEX "email_outbox_send_status_idx" ON "email_outbox" USING btree ("send_status");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_pk" ON "idempotency_keys" USING btree ("key","scope");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_source_idx" ON "webhook_deliveries" USING btree ("source");