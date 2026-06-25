CREATE TABLE "stocktake_lite_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"period" varchar(40) NOT NULL,
	"site_slug" varchar(80) NOT NULL,
	"device_id" varchar(80) NOT NULL,
	"counter_name" varchar(120) NOT NULL,
	"item_key" varchar(200) NOT NULL,
	"item_name" varchar(300) NOT NULL,
	"section" varchar(200),
	"pack_size" varchar(200),
	"quantity" numeric(18, 3) NOT NULL,
	"is_custom" boolean DEFAULT false NOT NULL,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stocktake_lite_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"period" varchar(40) NOT NULL,
	"site_slug" varchar(80) NOT NULL,
	"group_key" varchar(300) NOT NULL,
	"resolved_qty" numeric(18, 3) NOT NULL,
	"resolved_by" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "stocktake_lite_counts_device_item_unq" ON "stocktake_lite_counts" USING btree ("company_id","period","device_id","item_key");--> statement-breakpoint
CREATE INDEX "stocktake_lite_counts_site_idx" ON "stocktake_lite_counts" USING btree ("company_id","period","site_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "stocktake_lite_resolutions_unq" ON "stocktake_lite_resolutions" USING btree ("company_id","period","site_slug","group_key");