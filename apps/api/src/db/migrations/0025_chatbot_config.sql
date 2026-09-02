CREATE TABLE "chat_classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"turn_ordinal" integer NOT NULL,
	"category" text NOT NULL,
	"confidence" text NOT NULL,
	"classifier_version" integer,
	"latency_ms" integer,
	"cost_micro_usd" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatbot_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"store_name" text NOT NULL,
	"product_kind" text NOT NULL,
	"classifier_prompt" text NOT NULL,
	"offtopic_refusal" text NOT NULL,
	"escalation_email" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"target" text NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"saved_by" uuid,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "specialist_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"category" text NOT NULL,
	"system_prompt" text NOT NULL,
	"model_override" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_classifications" ADD CONSTRAINT "chat_classifications_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatbot_config" ADD CONSTRAINT "chatbot_config_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_saved_by_users_id_fk" FOREIGN KEY ("saved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialist_prompts" ADD CONSTRAINT "specialist_prompts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_classifications_session_idx" ON "chat_classifications" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "chat_classifications_category_idx" ON "chat_classifications" USING btree ("company_id","category","created_at");--> statement-breakpoint
CREATE INDEX "prompt_versions_target_idx" ON "prompt_versions" USING btree ("company_id","target","version");--> statement-breakpoint
CREATE UNIQUE INDEX "specialist_prompts_category_idx" ON "specialist_prompts" USING btree ("company_id","category");