CREATE TYPE "public"."supplier_connector_kind" AS ENUM('NONE', 'UNEEK', 'STUB');--> statement-breakpoint
CREATE TYPE "public"."supplier_order_status" AS ENUM('PENDING', 'PLACED', 'ACKNOWLEDGED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'FAILED');--> statement-breakpoint
CREATE TABLE "supplier_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_order_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"request_payload" jsonb,
	"supplier_order_ref" varchar(200),
	"status" "supplier_order_status" DEFAULT 'PENDING' NOT NULL,
	"response_payload" jsonb,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"tracking_carrier" varchar(100),
	"tracking_number" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "supplier_orders_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "supplier_poll_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"products_checked" integer DEFAULT 0 NOT NULL,
	"products_updated" integer DEFAULT 0 NOT NULL,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "supplier_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_sku" varchar(200) NOT NULL,
	"cost_gbp" numeric(12, 2) NOT NULL,
	"last_known_stock" integer,
	"last_known_price" numeric(12, 2),
	"last_polled_at" timestamp with time zone,
	"last_poll_error" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "slug" varchar(100);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "connector_kind" "supplier_connector_kind" DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "api_base_url" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "api_key_enc" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "api_auth_scheme" varchar(20) DEFAULT 'bearer' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "is_dropship_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "poll_interval_minutes" integer DEFAULT 180 NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "dispatch_sla_min_days" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "dispatch_sla_max_days" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "show_supplier_name_to_customers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_orders" ADD CONSTRAINT "supplier_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_poll_log" ADD CONSTRAINT "supplier_poll_log_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_products_product_supplier_unq" ON "supplier_products" USING btree ("product_id","supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_slug_unq" ON "suppliers" USING btree ("slug");