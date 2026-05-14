ALTER TABLE "suppliers" ADD COLUMN "rate_limit_requests" integer;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "rate_limit_window_seconds" integer;