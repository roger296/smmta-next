/**
 * Knowledge-base storage, chunking, and retrieval.
 *
 * Retrieval is Postgres full-text search over a GENERATED tsvector (see
 * migration 0027), weighted so a heading match outranks a body match.
 * Whole documents are re-chunked on every save rather than diffed:
 * these documents are a few kilobytes, saves are rare and operator-
 * driven, and a delete-then-insert inside one transaction is trivially
 * correct where an incremental diff would be a source of subtle
 * index-drift bugs.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { kbDocuments, kbChunks, type KbDocumentSlug } from '../../db/schema/index.js';
import { chunkMarkdown } from './kb-chunker.js';
import { KB_SEED_DOCUMENTS } from './kb-seed.js';

export interface KbSearchHit {
  heading: string;
  body: string;
  documentSlug: string;
  rank: number;
}

export interface KbDocumentView {
  id: string;
  slug: string;
  title: string;
  markdown: string;
  chunkCount: number;
  updatedAt: Date;
}

/** How many chunks a lookup returns. Three fits comfortably in a prompt
 *  alongside the conversation without crowding out the system rules. */
const DEFAULT_LIMIT = 3;

/**
 * Minimum ts_rank to count as a hit.
 *
 * Above zero on purpose: `plainto_tsquery` will match a chunk that
 * shares one common word with the question, and handing the specialist
 * a barely-related chunk invites it to answer from something that
 * doesn't actually address the question. Returning nothing is the
 * better failure — the prompts tell the specialist to say it doesn't
 * know and offer to pass the question on.
 */
const MIN_RANK = 0.01;

export class KbService {
  private db = getDb();
  private companyId = getSingletonCompanyId();

  /** All documents, seeding the defaults on first use. */
  async list(): Promise<KbDocumentView[]> {
    let rows = await this.db
      .select()
      .from(kbDocuments)
      .where(eq(kbDocuments.companyId, this.companyId));

    const missing = KB_SEED_DOCUMENTS.filter((s) => !rows.some((r) => r.slug === s.slug));
    if (missing.length > 0) {
      for (const seed of missing) {
        await this.save(seed.slug, seed.markdown, seed.title);
      }
      rows = await this.db
        .select()
        .from(kbDocuments)
        .where(eq(kbDocuments.companyId, this.companyId));
    }

    const counts = await this.db
      .select({
        documentId: kbChunks.documentId,
        n: sql<number>`count(*)::int`,
      })
      .from(kbChunks)
      .where(eq(kbChunks.companyId, this.companyId))
      .groupBy(kbChunks.documentId);
    const countBy = new Map(counts.map((c) => [c.documentId, Number(c.n)]));

    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      markdown: r.markdown,
      chunkCount: countBy.get(r.id) ?? 0,
      updatedAt: r.updatedAt,
    }));
  }

  async get(slug: KbDocumentSlug): Promise<KbDocumentView | null> {
    const all = await this.list();
    return all.find((d) => d.slug === slug) ?? null;
  }

  /**
   * Write a document and rebuild its chunks.
   *
   * Wrapped in a transaction so a failure part-way cannot leave the
   * document saved with the previous version's chunks — that would have
   * the assistant quoting text the operator thinks they deleted.
   */
  async save(
    slug: KbDocumentSlug,
    markdown: string,
    title?: string,
    userId?: string,
  ): Promise<KbDocumentView> {
    const chunks = chunkMarkdown(markdown);

    const documentId = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: kbDocuments.id, title: kbDocuments.title })
        .from(kbDocuments)
        .where(and(eq(kbDocuments.companyId, this.companyId), eq(kbDocuments.slug, slug)))
        .limit(1);

      let id: string;
      if (existing) {
        id = existing.id;
        await tx
          .update(kbDocuments)
          .set({
            markdown,
            title: title ?? existing.title,
            updatedBy: userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(kbDocuments.id, id));
        await tx.delete(kbChunks).where(eq(kbChunks.documentId, id));
      } else {
        const [inserted] = await tx
          .insert(kbDocuments)
          .values({
            companyId: this.companyId,
            slug,
            title: title ?? slug,
            markdown,
            updatedBy: userId ?? null,
          })
          .returning({ id: kbDocuments.id });
        id = inserted!.id;
      }

      if (chunks.length > 0) {
        await tx.insert(kbChunks).values(
          chunks.map((c) => ({
            companyId: this.companyId,
            documentId: id,
            ordinal: c.ordinal,
            heading: c.heading,
            body: c.body,
          })),
        );
      }
      return id;
    });

    const view = (await this.list()).find((d) => d.id === documentId);
    return view!;
  }

  /**
   * Full-text search across the knowledge base.
   *
   * `plainto_tsquery` rather than `to_tsquery` because the input is a
   * customer's own words — it handles punctuation and stop words
   * without us having to sanitise a query language, and it cannot be
   * made to throw on odd input the way `to_tsquery` can.
   */
  async search(query: string, limit = DEFAULT_LIMIT): Promise<KbSearchHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const rows = await this.db.execute<{
      heading: string;
      body: string;
      slug: string;
      rank: number;
    }>(sql`
      SELECT c.heading, c.body, d.slug,
             ts_rank(c.search_vec, plainto_tsquery('english', ${trimmed})) AS rank
      FROM ${kbChunks} c
      JOIN ${kbDocuments} d ON d.id = c.document_id
      WHERE c.company_id = ${this.companyId}
        AND c.search_vec @@ plainto_tsquery('english', ${trimmed})
      ORDER BY rank DESC
      LIMIT ${limit}
    `);

    const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
    return (list as Array<{ heading: string; body: string; slug: string; rank: number }>)
      .map((r) => ({
        heading: r.heading,
        body: r.body,
        documentSlug: r.slug,
        rank: Number(r.rank),
      }))
      .filter((r) => r.rank >= MIN_RANK);
  }
}
