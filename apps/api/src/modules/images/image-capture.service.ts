/**
 * ImageCaptureService (P23, spec §A10) — AI groundwork, no vision model.
 *
 * Accumulates a labelled image set (product reference photos + goods-in /
 * stock-take / consumption captures) keyed by SKU + site + timestamp, so a
 * future item-recognition / video-stock-take model has training + reference
 * data. Recording is best-effort: `recordPhotoRefs` swallows errors so a capture
 * never blocks the goods-in / stock-take workflow.
 */
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { imageCaptures, products } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

export type ImageCapture = typeof imageCaptures.$inferSelect;
export type ImageCaptureSource = 'REFERENCE' | 'GOODS_IN' | 'STOCK_TAKE' | 'CONSUMPTION' | 'SHELF';

/** A photo as captured in the goods-in / stock-take payloads. */
export interface PhotoRef {
  url: string;
  sku?: string;
  productId?: string;
  capturedAt?: string;
}

export class ImageCaptureService {
  private db = getDb();

  async record(input: {
    productId?: string | null;
    siteId?: string | null;
    source: ImageCaptureSource;
    imageRef: string;
    label?: string | null;
    sourceRef?: string | null;
    capturedAt?: Date;
    companyId?: string;
  }): Promise<ImageCapture> {
    const companyId = input.companyId ?? getSingletonCompanyId();
    const [row] = await this.db
      .insert(imageCaptures)
      .values({
        companyId,
        productId: input.productId ?? null,
        siteId: input.siteId ?? null,
        source: input.source,
        imageRef: input.imageRef,
        label: input.label ?? null,
        sourceRef: input.sourceRef ?? null,
        ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
      })
      .returning();
    return row!;
  }

  /**
   * Best-effort: record a batch of photo refs (from a goods-in receipt or a
   * stock-take). Resolves a `sku` to a product where given. Never throws — a
   * capture failure must not break the capturing workflow.
   */
  async recordPhotoRefs(input: {
    photoRefs: unknown;
    siteId?: string | null;
    source: ImageCaptureSource;
    sourceRef?: string | null;
    productId?: string | null;
    companyId?: string;
  }): Promise<number> {
    const companyId = input.companyId ?? getSingletonCompanyId();
    const refs = Array.isArray(input.photoRefs) ? (input.photoRefs as PhotoRef[]) : [];
    let recorded = 0;
    for (const ref of refs) {
      if (!ref || typeof ref.url !== 'string' || !ref.url) continue;
      try {
        let productId = ref.productId ?? input.productId ?? null;
        if (!productId && ref.sku) {
          const p = await this.db.query.products.findFirst({
            where: and(eq(products.companyId, companyId), eq(products.stockCode, ref.sku)),
            columns: { id: true },
          });
          productId = p?.id ?? null;
        }
        await this.record({
          productId,
          siteId: input.siteId ?? null,
          source: input.source,
          imageRef: ref.url,
          sourceRef: input.sourceRef ?? null,
          capturedAt: ref.capturedAt ? new Date(ref.capturedAt) : undefined,
          companyId,
        });
        recorded += 1;
      } catch {
        // swallow — never block the capture workflow
      }
    }
    return recorded;
  }

  /** Captures for a SKU (product), optionally narrowed to a site. Newest first. */
  async listForSku(params: { productId: string; siteId?: string; companyId?: string }): Promise<ImageCapture[]> {
    const companyId = params.companyId ?? getSingletonCompanyId();
    const where = [eq(imageCaptures.companyId, companyId), eq(imageCaptures.productId, params.productId)];
    if (params.siteId) where.push(eq(imageCaptures.siteId, params.siteId));
    return this.db.select().from(imageCaptures).where(and(...where)).orderBy(desc(imageCaptures.capturedAt));
  }

  /** Admin gallery: captures filtered by product / site / source, newest first. */
  async gallery(params: { productId?: string; siteId?: string; source?: ImageCaptureSource; companyId?: string } = {}): Promise<ImageCapture[]> {
    const companyId = params.companyId ?? getSingletonCompanyId();
    const where = [eq(imageCaptures.companyId, companyId)];
    if (params.productId) where.push(eq(imageCaptures.productId, params.productId));
    if (params.siteId) where.push(eq(imageCaptures.siteId, params.siteId));
    if (params.source) where.push(eq(imageCaptures.source, params.source));
    return this.db
      .select()
      .from(imageCaptures)
      .where(and(...where))
      .orderBy(desc(imageCaptures.capturedAt))
      .limit(500);
  }

  /** Find a capture by its image reference (used by the stub MCP tools). */
  async getByRef(imageRef: string, companyId = getSingletonCompanyId()): Promise<ImageCapture | undefined> {
    return this.db.query.imageCaptures.findFirst({
      where: and(eq(imageCaptures.companyId, companyId), eq(imageCaptures.imageRef, imageRef)),
    });
  }
}
