ALTER TABLE "subscriptions" ADD COLUMN "dunning_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "first_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "last_attempt_at" timestamp with time zone;