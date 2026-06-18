CREATE TYPE "public"."reorder_proposal_status" AS ENUM('PROPOSED', 'APPROVED', 'PLACED', 'EMAILED', 'REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "reorder_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"supplier_id" uuid,
	"suggested_qty_stock" numeric(18, 3) NOT NULL,
	"suggested_qty_purchase" numeric(18, 3),
	"purchase_uom" varchar(20),
	"unit_cost" numeric(18, 4),
	"currency_code" varchar(3) DEFAULT 'GBP' NOT NULL,
	"status" "reorder_proposal_status" DEFAULT 'PROPOSED' NOT NULL,
	"channel" "supplier_order_channel",
	"triggered_by" varchar(20) DEFAULT 'sweep' NOT NULL,
	"rendered_po" jsonb,
	"supplier_order_ref" varchar(200),
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"placed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "reorder_proposals" ADD CONSTRAINT "reorder_proposals_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_proposals" ADD CONSTRAINT "reorder_proposals_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_proposals" ADD CONSTRAINT "reorder_proposals_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reorder_proposals_product_site_idx" ON "reorder_proposals" USING btree ("product_id","site_id");--> statement-breakpoint
CREATE INDEX "reorder_proposals_status_idx" ON "reorder_proposals" USING btree ("status");