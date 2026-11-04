CREATE TYPE "public"."email_campaign_kind" AS ENUM('weekly_digest', 'new_product', 'back_in_stock', 'manual', 'automation');--> statement-breakpoint
CREATE TYPE "public"."email_campaign_status" AS ENUM('draft', 'pending_approval', 'scheduled', 'sending', 'paused', 'sent', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."email_class" AS ENUM('order_required', 'requested_service', 'service', 'marketing');--> statement-breakpoint
CREATE TYPE "public"."email_deliverability" AS ENUM('ok', 'soft_bounce', 'hard_bounce', 'complained', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."email_marketing_status" AS ENUM('all', 'transactional_only', 'never');--> statement-breakpoint
CREATE TYPE "public"."email_send_status" AS ENUM('queued', 'sent', 'delivered', 'deferred', 'bounced', 'dropped', 'opened', 'clicked', 'complained', 'unsubscribed');--> statement-breakpoint
CREATE TABLE "email_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"kind" "email_campaign_kind" NOT NULL,
	"automation_key" varchar(64),
	"class" "email_class" NOT NULL,
	"status" "email_campaign_status" DEFAULT 'draft' NOT NULL,
	"segment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"audience_count" integer,
	"subject" text DEFAULT '' NOT NULL,
	"preheader" text,
	"template_key" varchar(64) DEFAULT 'manual' NOT NULL,
	"content" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"variant_of" uuid,
	"ab_winner" varchar(1),
	"ab_decided_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"send_window_minutes" integer DEFAULT 0 NOT NULL,
	"override_gap" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"utm_campaign" varchar(100),
	"expanded_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_consent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"from_status" "email_marketing_status",
	"to_status" "email_marketing_status" NOT NULL,
	"source" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"ip" varchar(64),
	"user_agent" text,
	"evidence" jsonb,
	"txid" bigint DEFAULT txid_current() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"email" varchar(320) NOT NULL,
	"customer_id" uuid,
	"storefront_user_id" uuid,
	"marketing_status" "email_marketing_status" DEFAULT 'transactional_only' NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_reason" text,
	"consent_source" text NOT NULL,
	"consent_at" timestamp with time zone,
	"consent_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deliverability" "email_deliverability" DEFAULT 'ok' NOT NULL,
	"soft_bounce_count" integer DEFAULT 0 NOT NULL,
	"soft_bounce_since" timestamp with time zone,
	"bouncer_result" text,
	"bouncer_reason" text,
	"bouncer_checked_at" timestamp with time zone,
	"interests" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_trade" boolean DEFAULT false NOT NULL,
	"digest_enabled" boolean DEFAULT true NOT NULL,
	"new_product_alerts_enabled" boolean DEFAULT true NOT NULL,
	"last_marketing_at" timestamp with time zone,
	"last_digest_at" timestamp with time zone,
	"last_open_at" timestamp with time zone,
	"last_click_at" timestamp with time zone,
	"last_order_at" timestamp with time zone,
	"preferred_hour" integer,
	"unsubscribe_token" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_contacts_email_normalised" CHECK ("email_contacts"."email" = lower(btrim("email_contacts"."email")))
);
--> statement-breakpoint
CREATE TABLE "email_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"send_id" uuid,
	"sg_event_id" varchar(200) NOT NULL,
	"event" varchar(40) NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"list_type" varchar(32) NOT NULL,
	"default_status" "email_marketing_status",
	"default_interests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"consent_source" varchar(64) NOT NULL,
	"file_sha256" varchar(64) NOT NULL,
	"evidence_path" text,
	"dry_run" boolean NOT NULL,
	"dry_run_id" uuid,
	"row_count" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_rate_limit" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"refilled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"campaign_id" uuid,
	"contact_id" uuid NOT NULL,
	"class" "email_class" NOT NULL,
	"kind" varchar(64) NOT NULL,
	"template_key" varchar(64) NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"variant" varchar(1),
	"idempotency_key" varchar(200) NOT NULL,
	"status" "email_send_status" DEFAULT 'queued' NOT NULL,
	"drop_reason" varchar(64),
	"subject" text,
	"sendgrid_message_id" varchar(200),
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"first_open_at" timestamp with time zone,
	"first_click_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_settings" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"class" "email_class" NOT NULL,
	"subject_template" text NOT NULL,
	"body_source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD CONSTRAINT "email_campaigns_variant_of_email_campaigns_id_fk" FOREIGN KEY ("variant_of") REFERENCES "public"."email_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_consent_events" ADD CONSTRAINT "email_consent_events_contact_id_email_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."email_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_contacts" ADD CONSTRAINT "email_contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_contacts" ADD CONSTRAINT "email_contacts_storefront_user_id_storefront_users_id_fk" FOREIGN KEY ("storefront_user_id") REFERENCES "public"."storefront_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_send_id_email_sends_id_fk" FOREIGN KEY ("send_id") REFERENCES "public"."email_sends"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_imports" ADD CONSTRAINT "email_imports_dry_run_id_email_imports_id_fk" FOREIGN KEY ("dry_run_id") REFERENCES "public"."email_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_campaign_id_email_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."email_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_contact_id_email_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."email_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_campaigns_status_idx" ON "email_campaigns" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "email_consent_events_contact_idx" ON "email_consent_events" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_contacts_email_unq" ON "email_contacts" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "email_contacts_unsubscribe_token_unq" ON "email_contacts" USING btree ("unsubscribe_token");--> statement-breakpoint
CREATE INDEX "email_contacts_customer_idx" ON "email_contacts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "email_contacts_status_idx" ON "email_contacts" USING btree ("marketing_status","deliverability");--> statement-breakpoint
CREATE UNIQUE INDEX "email_events_sg_event_id_unq" ON "email_events" USING btree ("sg_event_id");--> statement-breakpoint
CREATE INDEX "email_events_send_idx" ON "email_events" USING btree ("send_id");--> statement-breakpoint
CREATE INDEX "email_events_received_idx" ON "email_events" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_sends_idempotency_key_unq" ON "email_sends" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "email_sends_queue_idx" ON "email_sends" USING btree ("status","not_before");--> statement-breakpoint
CREATE INDEX "email_sends_contact_idx" ON "email_sends" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE INDEX "email_sends_campaign_idx" ON "email_sends" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "email_sends_sendgrid_message_idx" ON "email_sends" USING btree ("sendgrid_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_templates_key_version_unq" ON "email_templates" USING btree ("key","version");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_contact_id_email_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."email_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Consent events are the PECR evidence trail: append-only. The one exception is
-- an erasure (right to be forgotten), which sets email.purge = 'on' for its own
-- transaction before deleting a person's rows.
CREATE FUNCTION email_consent_events_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('email.purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'email_consent_events is append-only (consent evidence); % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER email_consent_events_no_update BEFORE UPDATE ON email_consent_events FOR EACH ROW EXECUTE FUNCTION email_consent_events_append_only();--> statement-breakpoint
CREATE TRIGGER email_consent_events_no_delete BEFORE DELETE ON email_consent_events FOR EACH ROW EXECUTE FUNCTION email_consent_events_append_only();--> statement-breakpoint
-- marketing_status only moves through email_consent_events: an UPDATE that
-- changes it must be matched by a consent event for this contact, to the new
-- status, written earlier in the same transaction (txid_current()). The
-- contacts service writes the event and then the contact.
CREATE FUNCTION email_contacts_status_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.marketing_status IS DISTINCT FROM OLD.marketing_status THEN
    IF NOT EXISTS (
      SELECT 1 FROM email_consent_events e
      WHERE e.contact_id = NEW.id
        AND e.to_status = NEW.marketing_status
        AND e.txid = txid_current()
    ) THEN
      RAISE EXCEPTION 'email_contacts.marketing_status may only change through a consent event (contact %)', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER email_contacts_status_guard BEFORE UPDATE ON email_contacts FOR EACH ROW EXECUTE FUNCTION email_contacts_status_guard();
