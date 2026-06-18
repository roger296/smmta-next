CREATE TABLE "bumblebee_sync_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_system" varchar(60) DEFAULT 'autostock' NOT NULL,
	"source_key" varchar(200) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"kind" varchar(60) DEFAULT 'materials_cost' NOT NULL,
	"status" varchar(20) DEFAULT 'SUCCESS' NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"amount" numeric(18, 2),
	"payload" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bumblebee_sync_source_unq" ON "bumblebee_sync_log" USING btree ("source_system","source_key","content_hash");