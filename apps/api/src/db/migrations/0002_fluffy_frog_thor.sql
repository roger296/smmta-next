CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"key_hash" varchar(255) NOT NULL,
	"prefix" varchar(16) NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_company_id_name_unq" ON "api_keys" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_unq" ON "api_keys" USING btree ("prefix");