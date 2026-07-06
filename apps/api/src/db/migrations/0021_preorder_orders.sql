CREATE TABLE "preorder_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"pool_ref" text NOT NULL,
	"sku" text NOT NULL,
	"qty" integer NOT NULL,
	"locked_unit_price_pence" integer NOT NULL,
	"locked_band_bp" integer NOT NULL,
	"locked_saving_pence" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preorder_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'awaiting_payment' NOT NULL,
	"payment_method" text NOT NULL,
	"payment_reference" text NOT NULL,
	"mollie_payment_id" text,
	"total_pence" integer NOT NULL,
	"overdue_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"lapsed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "uq_preorder_payment_reference" UNIQUE("company_id","payment_reference")
);
--> statement-breakpoint
ALTER TABLE "preorder_order_lines" ADD CONSTRAINT "preorder_order_lines_order_id_preorder_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."preorder_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preorder_orders" ADD CONSTRAINT "preorder_orders_user_id_storefront_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."storefront_users"("id") ON DELETE no action ON UPDATE no action;