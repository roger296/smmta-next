CREATE INDEX "customer_orders_email_campaign_idx" ON "customer_orders" USING btree ("email_campaign_id");--> statement-breakpoint
CREATE INDEX "customer_orders_email_send_idx" ON "customer_orders" USING btree ("email_send_id");--> statement-breakpoint
CREATE INDEX "email_sends_kind_queued_idx" ON "email_sends" USING btree ("kind","queued_at");--> statement-breakpoint
CREATE INDEX "email_sends_sent_at_idx" ON "email_sends" USING btree ("sent_at");