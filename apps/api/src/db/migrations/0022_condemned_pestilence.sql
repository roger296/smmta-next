CREATE TYPE "public"."goods_in_variance" AS ENUM('NONE', 'UNDER', 'OVER');--> statement-breakpoint
CREATE TABLE "goods_in_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"qty_purchase" numeric(18, 3) NOT NULL,
	"qty_stock" numeric(18, 3) NOT NULL,
	"unit_cost" numeric(18, 4) DEFAULT '0' NOT NULL,
	"line_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"expected_qty_purchase" numeric(18, 3),
	"line_variance" "goods_in_variance" DEFAULT 'NONE' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "goods_in_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"supplier_id" uuid,
	"reorder_proposal_id" uuid,
	"reference" varchar(200),
	"idempotency_key" varchar(200) NOT NULL,
	"delivery_charge" numeric(18, 2) DEFAULT '0' NOT NULL,
	"total_stock_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"variance" "goods_in_variance" DEFAULT 'NONE' NOT NULL,
	"photo_refs" jsonb,
	"gl_reference" varchar(200),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "goods_in_receipts_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "goods_in_receipt_lines" ADD CONSTRAINT "goods_in_receipt_lines_receipt_id_goods_in_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."goods_in_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_in_receipt_lines" ADD CONSTRAINT "goods_in_receipt_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_in_receipts" ADD CONSTRAINT "goods_in_receipts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_in_receipts" ADD CONSTRAINT "goods_in_receipts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_in_receipts" ADD CONSTRAINT "goods_in_receipts_reorder_proposal_id_reorder_proposals_id_fk" FOREIGN KEY ("reorder_proposal_id") REFERENCES "public"."reorder_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goods_in_receipt_lines_receipt_idx" ON "goods_in_receipt_lines" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "goods_in_receipts_site_idx" ON "goods_in_receipts" USING btree ("site_id");