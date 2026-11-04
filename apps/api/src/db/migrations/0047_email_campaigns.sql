CREATE TABLE "email_weekly_content" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"week_start" varchar(10) NOT NULL,
	"key" varchar(80) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"url" text,
	"price_gbp" varchar(16),
	"saving_gbp" varchar(16),
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "hero" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "email_weekly_content_week_idx" ON "email_weekly_content" USING btree ("week_start","kind");