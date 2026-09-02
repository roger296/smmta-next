ALTER TABLE "escalations" ADD COLUMN "chat_category" text;--> statement-breakpoint
ALTER TABLE "escalations" ADD COLUMN "priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "escalations" ADD COLUMN "email_sent_at" timestamp with time zone;