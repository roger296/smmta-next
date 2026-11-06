ALTER TABLE "email_contacts" ADD COLUMN "lists" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "email_contacts_lists_idx" ON "email_contacts" USING gin ("lists");