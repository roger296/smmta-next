/**
 * Chatbot knowledge base.
 *
 * Two markdown documents per store — `faq` (delivery, returns, policy)
 * and `product-advice` (how to use what the store sells) — authored in
 * admin and chunked on save. The delivery/returns and product-advice
 * specialists answer ONLY from these chunks, so an operator editing the
 * markdown is directly editing what the assistant is allowed to say.
 *
 * Retrieval is Postgres full-text search, not embeddings. For a
 * hand-written knowledge base of a few dozen entries, `ts_rank` over a
 * weighted tsvector retrieves about as well as cosine similarity would,
 * with no extension to install, no embedding API call on every save, and
 * no re-index cost when the operator fixes a typo. The chunk table is
 * shaped so an `embedding` column can be added later without moving
 * anything else if recall turns out to need it.
 *
 * `search_vec` is a GENERATED ALWAYS column (see migration 0027) so it
 * can never drift from the text it indexes — there is no code path that
 * writes body without updating the index.
 */
import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { pk, companyId } from './common.js';
import { users } from './auth.js';

/** The documents a store can hold. Slugs are code-defined because the
 *  specialists reference them; the CONTENT is entirely admin-owned. */
export const KB_DOCUMENT_SLUGS = ['faq', 'product-advice'] as const;
export type KbDocumentSlug = (typeof KB_DOCUMENT_SLUGS)[number];

export const kbDocuments = pgTable('kb_documents', {
  id: pk(),
  companyId: companyId(),
  /** 'faq' | 'product-advice' */
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  /** The source of truth. Chunks are derived from this on every save. */
  markdown: text('markdown').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugIdx: uniqueIndex('kb_documents_slug_idx').on(t.companyId, t.slug),
}));

export const kbChunks = pgTable('kb_chunks', {
  id: pk(),
  companyId: companyId(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => kbDocuments.id, { onDelete: 'cascade' }),
  /** Position within the document, for stable ordering + citation. */
  ordinal: integer('ordinal').notNull(),
  /** Nearest heading above this chunk. Weighted higher than body in the
   *  search vector — a heading is a strong signal of what a chunk is
   *  about, and FAQ headings are literally the customer's question. */
  heading: text('heading').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  documentIdx: index('kb_chunks_document_idx').on(t.documentId, t.ordinal),
  companyIdx: index('kb_chunks_company_idx').on(t.companyId),
}));
