CREATE TABLE "email_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"tool" varchar(80) NOT NULL,
	"actor" text NOT NULL,
	"args" jsonb,
	"ok" boolean NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "email_audit_created_idx" ON "email_audit" USING btree ("created_at");