ALTER TABLE "stock_notifications" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_notifications" ADD COLUMN "email_send_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_notifications" ADD COLUMN "close_reason" varchar(32);--> statement-breakpoint
ALTER TABLE "stock_notifications" ADD CONSTRAINT "stock_notifications_contact_id_email_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."email_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_notifications" ADD CONSTRAINT "stock_notifications_email_send_id_email_sends_id_fk" FOREIGN KEY ("email_send_id") REFERENCES "public"."email_sends"("id") ON DELETE no action ON UPDATE no action;