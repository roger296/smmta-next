CREATE TABLE "email_carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"external_cart_id" varchar(100) NOT NULL,
	"channel" varchar(64) DEFAULT 'storefront' NOT NULL,
	"contact_id" uuid NOT NULL,
	"lines" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ordered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_material_content" (
	"key" varchar(80) PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"markdown" text NOT NULL,
	"needs_review" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_price_snapshots" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"price_gbp" varchar(20) NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_carts" ADD CONSTRAINT "email_carts_contact_id_email_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."email_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_carts_external_unq" ON "email_carts" USING btree ("channel","external_cart_id");--> statement-breakpoint
CREATE INDEX "email_carts_contact_idx" ON "email_carts" USING btree ("contact_id");--> statement-breakpoint
-- Placeholder printing tips for post-purchase emails. Short and neutral on
-- purpose: Roger edits them (needs_review stays true until he does).
INSERT INTO "email_material_content" ("key", "company_id", "markdown") VALUES
  ('material:pla', '11111111-1111-4111-8111-111111111111', 'PLA prints best at 190–220 °C on a bed at 50–60 °C. Keep the spool dry and sealed between prints.'),
  ('material:petg', '11111111-1111-4111-8111-111111111111', 'PETG likes 230–250 °C with a bed at 70–85 °C. Slow the travel moves a little if you see stringing.'),
  ('material:abs', '11111111-1111-4111-8111-111111111111', 'ABS needs 230–260 °C, a bed at 95–110 °C and an enclosure to stop warping. Ventilate the room.'),
  ('material:asa', '11111111-1111-4111-8111-111111111111', 'ASA prints like ABS (240–260 °C, bed 90–110 °C, enclosure) and stands up to sunlight outdoors.'),
  ('material:tpu', '11111111-1111-4111-8111-111111111111', 'TPU wants slow, steady printing (20–30 mm/s) at 210–230 °C. A direct-drive extruder helps.'),
  ('material:nylon', '11111111-1111-4111-8111-111111111111', 'Nylon soaks up moisture fast: dry it before printing and keep it in a dry box. 240–270 °C.'),
  ('material:carbon', '11111111-1111-4111-8111-111111111111', 'Carbon-fibre blends wear brass nozzles quickly; use a hardened steel nozzle.')
ON CONFLICT ("key") DO NOTHING;
