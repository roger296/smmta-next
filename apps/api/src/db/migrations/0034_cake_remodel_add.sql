DROP INDEX "recipes_company_experience_site_version_unq";--> statement-breakpoint
DROP INDEX "recipes_lookup_idx";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_experience_booking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "bake" varchar(200) NOT NULL;--> statement-breakpoint
ALTER TABLE "session_consumption" ADD COLUMN "bake" varchar(200);--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_company_bake_site_version_unq" ON "recipes" USING btree ("company_id","bake","site_id","version");--> statement-breakpoint
CREATE INDEX "recipes_lookup_idx" ON "recipes" USING btree ("company_id","bake","site_id");