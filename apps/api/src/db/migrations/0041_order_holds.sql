CREATE TABLE "order_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"holder_key" varchar(60) NOT NULL,
	"reason" varchar(300) NOT NULL,
	"placed_by" uuid,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "order_holds" ADD CONSTRAINT "order_holds_order_id_customer_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."customer_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_holds_live_unq" ON "order_holds" USING btree ("order_id","holder_key") WHERE "order_holds"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "order_holds_order_idx" ON "order_holds" USING btree ("order_id");