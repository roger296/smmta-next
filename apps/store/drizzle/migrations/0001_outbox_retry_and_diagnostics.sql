ALTER TABLE "email_outbox" ADD COLUMN "last_status_code" integer;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "provider_message_id" varchar(200);--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "email_outbox_retry_idx" ON "email_outbox" USING btree ("send_status","next_attempt_at");