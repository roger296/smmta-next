CREATE TABLE "session_consumption" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"session_id" varchar(200) NOT NULL,
	"session_date" date NOT NULL,
	"baker_name" varchar(200) NOT NULL,
	"baker_ref" varchar(200),
	"version" integer DEFAULT 0 NOT NULL,
	"client_key" varchar(200),
	"materials_cost" numeric(18, 2) DEFAULT '0' NOT NULL,
	"currency_code" varchar(3) DEFAULT 'GBP' NOT NULL,
	"notes" text,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "session_consumption_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"consumption_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"expected_qty" numeric(18, 3) DEFAULT '0' NOT NULL,
	"actual_qty" numeric(18, 3) DEFAULT '0' NOT NULL,
	"wastage_qty" numeric(18, 3) DEFAULT '0' NOT NULL,
	"wastage_reason" varchar(200),
	"unit_cost" numeric(18, 4),
	"variance" numeric(18, 3) DEFAULT '0' NOT NULL,
	"stock_uom" varchar(20) DEFAULT 'each' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "session_consumption" ADD CONSTRAINT "session_consumption_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_consumption_lines" ADD CONSTRAINT "session_consumption_lines_consumption_id_session_consumption_id_fk" FOREIGN KEY ("consumption_id") REFERENCES "public"."session_consumption"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_consumption_lines" ADD CONSTRAINT "session_consumption_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_consumption_company_session_unq" ON "session_consumption" USING btree ("company_id","session_id");--> statement-breakpoint
CREATE INDEX "session_consumption_site_date_idx" ON "session_consumption" USING btree ("site_id","session_date");--> statement-breakpoint
CREATE UNIQUE INDEX "session_consumption_lines_consumption_product_unq" ON "session_consumption_lines" USING btree ("consumption_id","product_id");