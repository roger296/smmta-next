CREATE TABLE "mcp_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key_prefix" varchar(16),
	"tool_name" varchar(80) NOT NULL,
	"args" jsonb,
	"ok" boolean DEFAULT true NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mcp_audit_tool_idx" ON "mcp_audit_log" USING btree ("tool_name");--> statement-breakpoint
CREATE INDEX "mcp_audit_created_idx" ON "mcp_audit_log" USING btree ("created_at");