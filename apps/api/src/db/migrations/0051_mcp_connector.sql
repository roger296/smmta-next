CREATE TABLE "mcp_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key_prefix" varchar(16) NOT NULL,
	"user_id" uuid,
	"tool" varchar(80) NOT NULL,
	"method" varchar(8) NOT NULL,
	"path" text NOT NULL,
	"status" integer NOT NULL,
	"ok" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "acting_user_id" uuid;--> statement-breakpoint
CREATE INDEX "mcp_audit_created_idx" ON "mcp_audit" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_acting_user_id_users_id_fk" FOREIGN KEY ("acting_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;