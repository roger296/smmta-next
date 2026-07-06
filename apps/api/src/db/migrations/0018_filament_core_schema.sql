CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"consent_type" text NOT NULL,
	"granted" boolean NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storefront_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"email" varchar(320),
	"email_verified" timestamp with time zone,
	"display_name" varchar(200),
	"kind" text DEFAULT 'guest' NOT NULL,
	"merged_into" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storefront_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "suppression_list" (
	"email" varchar(320) PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interest_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"sku" text,
	"prospective_id" uuid,
	"flag_type" text NOT NULL,
	"deposit_paid_pence" integer,
	"source_page" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	CONSTRAINT "uq_flag" UNIQUE NULLS NOT DISTINCT("user_id","sku","prospective_id","flag_type")
);
--> statement-breakpoint
CREATE TABLE "prospective_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'considering' NOT NULL,
	"interest_threshold" integer,
	"threshold_crossed_at" timestamp with time zone,
	"deposit_pence" integer,
	"creator_partner" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_shipment_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"qty_manifested" integer NOT NULL,
	"qty_received" integer,
	"qty_presold" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"mode" text DEFAULT 'sea' NOT NULL,
	"supplier" text,
	"carrier" text,
	"eta_original" timestamp with time zone NOT NULL,
	"eta" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'booked' NOT NULL,
	"tracking_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tracking_url" text,
	"notes" text,
	"buffer_pct" integer DEFAULT 8 NOT NULL,
	"arrived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text,
	"tool_calls" jsonb,
	"tool_results" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid,
	"basket_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "llm_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"request_json" jsonb NOT NULL,
	"response_json" jsonb,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"latency_ms" integer,
	"cost_micro_usd" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_config" (
	"event_type" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"auto_send_enabled" boolean DEFAULT false NOT NULL,
	"approved_unedited_rate_bp" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"chat_session_id" uuid,
	"reason" text NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"trigger_event_id" uuid,
	"channel" text DEFAULT 'email' NOT NULL,
	"category" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"editor_notes" text,
	"sendgrid_message_id" text,
	"expires_at" timestamp with time zone,
	"group_key" text,
	"reject_reason" text,
	"body_original" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "subscription_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_pence" integer,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"mollie_customer_id" text NOT NULL,
	"mollie_mandate_id" text,
	"plan" text NOT NULL,
	"status" text NOT NULL,
	"credit_balance_pence" integer DEFAULT 0 NOT NULL,
	"renews_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"category" text,
	"preorder_bands" jsonb NOT NULL,
	"carton_discount_bp" integer DEFAULT 1000 NOT NULL,
	"max_stack_bp" integer DEFAULT 3000 NOT NULL,
	"min_contribution_bp" integer DEFAULT 1500 NOT NULL,
	"variable_fulfilment_pence" integer DEFAULT 0 NOT NULL,
	"payment_fee_bp" integer DEFAULT 200 NOT NULL,
	"low_stock_threshold" integer DEFAULT 10 NOT NULL,
	"quote_ttl_minutes" integer DEFAULT 30 NOT NULL,
	"bank_only_eta_days" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_pricing_rules_category" UNIQUE NULLS NOT DISTINCT("company_id","category")
);
--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_storefront_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."storefront_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_user_id_storefront_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."storefront_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_flags" ADD CONSTRAINT "interest_flags_user_id_storefront_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."storefront_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_flags" ADD CONSTRAINT "interest_flags_prospective_id_prospective_products_id_fk" FOREIGN KEY ("prospective_id") REFERENCES "public"."prospective_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_shipment_lines" ADD CONSTRAINT "inbound_shipment_lines_shipment_id_inbound_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."inbound_shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_storefront_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."storefront_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_chat_session_id_chat_sessions_id_fk" FOREIGN KEY ("chat_session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_user_id_storefront_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."storefront_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_trigger_event_id_domain_events_id_fk" FOREIGN KEY ("trigger_event_id") REFERENCES "public"."domain_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_storefront_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."storefront_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_provider_account" ON "auth_identities" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_shipment_sku" ON "inbound_shipment_lines" USING btree ("shipment_id","sku");--> statement-breakpoint
CREATE FUNCTION consent_records_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'consent_records is append-only (PECR evidence trail); % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER consent_records_no_update BEFORE UPDATE ON consent_records FOR EACH ROW EXECUTE FUNCTION consent_records_append_only();--> statement-breakpoint
CREATE TRIGGER consent_records_no_delete BEFORE DELETE ON consent_records FOR EACH ROW EXECUTE FUNCTION consent_records_append_only();
