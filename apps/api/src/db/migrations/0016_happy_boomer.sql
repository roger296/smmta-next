CREATE TABLE "llm_search_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"query" text NOT NULL,
	"query_hash" varchar(64) NOT NULL,
	"parsed_output" jsonb,
	"confidence" varchar(10),
	"result_count" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"cost_gbp" numeric(8, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "llm_search_log_created_id_unq" ON "llm_search_log" USING btree ("created_at","id");