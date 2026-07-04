CREATE TABLE "run_out_predictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"median_interval_days" integer NOT NULL,
	"purchase_count" integer NOT NULL,
	"last_purchase_at" timestamp with time zone NOT NULL,
	"predicted_run_out_at" timestamp with time zone NOT NULL,
	"regular" text DEFAULT 'no' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_run_out_user_sku" UNIQUE("user_id","sku")
);
--> statement-breakpoint
ALTER TABLE "run_out_predictions" ADD CONSTRAINT "run_out_predictions_user_id_storefront_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."storefront_users"("id") ON DELETE no action ON UPDATE no action;