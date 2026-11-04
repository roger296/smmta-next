ALTER TABLE "customers" DROP CONSTRAINT "customers_contact_id_email_contacts_id_fk";
--> statement-breakpoint
ALTER TABLE "stock_notifications" DROP CONSTRAINT "stock_notifications_contact_id_email_contacts_id_fk";
--> statement-breakpoint
ALTER TABLE "stock_notifications" DROP CONSTRAINT "stock_notifications_email_send_id_email_sends_id_fk";
--> statement-breakpoint
ALTER TABLE "email_contacts" DROP CONSTRAINT "email_contacts_customer_id_customers_id_fk";
--> statement-breakpoint
ALTER TABLE "email_contacts" DROP CONSTRAINT "email_contacts_storefront_user_id_storefront_users_id_fk";
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_contact_id_email_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."email_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_notifications" ADD CONSTRAINT "stock_notifications_contact_id_email_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."email_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_notifications" ADD CONSTRAINT "stock_notifications_email_send_id_email_sends_id_fk" FOREIGN KEY ("email_send_id") REFERENCES "public"."email_sends"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_contacts" ADD CONSTRAINT "email_contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_contacts" ADD CONSTRAINT "email_contacts_storefront_user_id_storefront_users_id_fk" FOREIGN KEY ("storefront_user_id") REFERENCES "public"."storefront_users"("id") ON DELETE set null ON UPDATE no action;