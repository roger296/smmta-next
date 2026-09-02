CREATE TABLE "kb_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"heading" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"markdown" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_document_id_kb_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."kb_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_chunks_document_idx" ON "kb_chunks" USING btree ("document_id","ordinal");--> statement-breakpoint
CREATE INDEX "kb_chunks_company_idx" ON "kb_chunks" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_documents_slug_idx" ON "kb_documents" USING btree ("company_id","slug");--> statement-breakpoint
-- Full-text search index over KB chunks.
--
-- GENERATED ALWAYS rather than a trigger or an application-side write:
-- there is then no code path that can update `body` and leave the index
-- stale, which is the usual way search quietly rots.
--
-- Heading is weighted 'A' and body 'B'. FAQ headings are literally the
-- customer's question ("What's your returns policy?"), so a heading
-- match is a much stronger signal than the same words appearing
-- somewhere in a paragraph.
ALTER TABLE "kb_chunks" ADD COLUMN "search_vec" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("heading", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("body", '')), 'B')
  ) STORED;--> statement-breakpoint
CREATE INDEX "kb_chunks_search_idx" ON "kb_chunks" USING gin ("search_vec");
