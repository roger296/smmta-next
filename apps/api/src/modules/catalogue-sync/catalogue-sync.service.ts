/**
 * Shared product catalogue with BumbleBee (P11, spec §A4).
 *
 * Auto-Stock is the system-of-record. This service:
 *   - imports BumbleBee products (a provided export, or — later — pulled via
 *     the API) into Auto-Stock products carrying `bumblebee_product_id`,
 *     idempotently (match by bumblebee id, then name/sku);
 *   - maps BumbleBee `product_type` → Auto-Stock `item_kind`;
 *   - pushes a slim subset (identity, name, category, sale price) back to a
 *     BumbleBee write endpoint **when one exists** — guarded by CATALOGUE_SYNC
 *     (default off); otherwise it logs the intended payload and sends nothing;
 *   - reports reconciliation gaps (Auto-Stock products without a BumbleBee id,
 *     and BumbleBee products not yet stocked).
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getEnv } from '../../config/env.js';
import { products } from '../../db/schema/index.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';

export type ItemKind = 'MERCH' | 'RETAIL' | 'INGREDIENT' | 'PACKAGING';

/** BumbleBee `product_type` → Auto-Stock `item_kind`. Unknown ⇒ RETAIL. */
const PRODUCT_TYPE_TO_ITEM_KIND: Record<string, ItemKind> = {
  MERCH: 'MERCH',
  RETAIL: 'RETAIL',
  INGREDIENT: 'INGREDIENT',
  PACKAGING: 'PACKAGING',
  // BumbleBee sold-but-not-stocked types map to RETAIL (sold) by default.
  EBOOK: 'RETAIL',
  EXPERIENCE: 'RETAIL',
  BOOKING_FEE: 'RETAIL',
};

export function bumblebeeTypeToItemKind(productType: string | null | undefined): ItemKind {
  if (!productType) return 'RETAIL';
  return PRODUCT_TYPE_TO_ITEM_KIND[productType.toUpperCase()] ?? 'RETAIL';
}

export interface BumbleBeeProductRow {
  bumblebeeProductId: string;
  name: string;
  productType?: string | null;
  costPrice?: number | string | null;
  defaultSalePrice?: number | string | null;
  sku?: string | null;
}

export interface ImportResult {
  created: number;
  updated: number;
}

const slug = (name: string, id: string): string =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 180)}-${id.slice(0, 8)}`;

export class CatalogueSyncService {
  private db = getDb();

  /** Idempotent import. Matches by bumblebee_product_id, then by stock_code/name. */
  async importProducts(
    rows: BumbleBeeProductRow[],
    companyId = getSingletonCompanyId(),
  ): Promise<ImportResult> {
    let created = 0;
    let updated = 0;
    for (const row of rows) {
      const itemKind = bumblebeeTypeToItemKind(row.productType);
      const existing =
        (await this.db.query.products.findFirst({
          where: and(
            eq(products.companyId, companyId),
            eq(products.bumblebeeProductId, row.bumblebeeProductId),
          ),
        })) ??
        (row.sku
          ? await this.db.query.products.findFirst({
              where: and(eq(products.companyId, companyId), eq(products.stockCode, row.sku)),
            })
          : undefined) ??
        (await this.db.query.products.findFirst({
          where: and(eq(products.companyId, companyId), eq(products.name, row.name)),
        }));

      const values = {
        name: row.name,
        itemKind,
        bumblebeeProductId: row.bumblebeeProductId,
        expectedNextCost: row.costPrice != null ? String(row.costPrice) : undefined,
        minSellingPrice: row.defaultSalePrice != null ? String(row.defaultSalePrice) : undefined,
        ...(row.sku ? { stockCode: row.sku } : {}),
      };

      if (existing) {
        await this.db
          .update(products)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(products.id, existing.id));
        updated += 1;
      } else {
        await this.db.insert(products).values({
          companyId,
          slug: slug(row.name, row.bumblebeeProductId),
          ...values,
        });
        created += 1;
      }
    }
    return { created, updated };
  }

  /** The slim subset BumbleBee consumes (identity, name, category, sale price). */
  async buildSlimSubset(companyId = getSingletonCompanyId()) {
    const rows = await this.db.query.products.findMany({
      where: and(
        eq(products.companyId, companyId),
        isNotNull(products.bumblebeeProductId),
        isNull(products.deletedAt),
      ),
      columns: {
        bumblebeeProductId: true,
        name: true,
        categoryId: true,
        minSellingPrice: true,
      },
    });
    return rows.map((r) => ({
      bumblebeeProductId: r.bumblebeeProductId,
      name: r.name,
      categoryId: r.categoryId,
      salePrice: r.minSellingPrice,
    }));
  }

  /**
   * Push the slim subset to BumbleBee. Guarded by CATALOGUE_SYNC: off (default)
   * ⇒ dry-run (logs the payload, sends nothing). The BumbleBee write endpoint
   * is a documented follow-up.
   */
  async pushSlimSubset(companyId = getSingletonCompanyId()): Promise<{ dryRun: boolean; count: number }> {
    const env = getEnv();
    const payload = await this.buildSlimSubset(companyId);
    if (!env.CATALOGUE_SYNC || !env.BUMBLEBEE_API_BASE_URL) {
      // Dry-run — log + send nothing.
      // eslint-disable-next-line no-console
      console.info(`[catalogue-sync] dry-run: would push ${payload.length} products`);
      return { dryRun: true, count: payload.length };
    }
    // Live push (go-live; the BumbleBee endpoint is a follow-up).
    await fetch(`${env.BUMBLEBEE_API_BASE_URL}/api/v1/catalogue/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.BUMBLEBEE_API_KEY ? { Authorization: `Bearer ${env.BUMBLEBEE_API_KEY}` } : {}),
      },
      body: JSON.stringify({ products: payload }),
    });
    return { dryRun: false, count: payload.length };
  }

  /** Gaps: Auto-Stock products without a BumbleBee id; BumbleBee ids not yet stocked. */
  async reconcile(
    bumblebeeProductIds: string[],
    companyId = getSingletonCompanyId(),
  ): Promise<{ unlinked: Array<{ id: string; name: string }>; notStocked: string[] }> {
    const unlinked = await this.db.query.products.findMany({
      where: and(
        eq(products.companyId, companyId),
        isNull(products.bumblebeeProductId),
        isNull(products.deletedAt),
      ),
      columns: { id: true, name: true },
    });
    const stocked = await this.db.query.products.findMany({
      where: and(eq(products.companyId, companyId), isNotNull(products.bumblebeeProductId)),
      columns: { bumblebeeProductId: true },
    });
    const stockedIds = new Set(stocked.map((s) => s.bumblebeeProductId));
    const notStocked = bumblebeeProductIds.filter((id) => !stockedIds.has(id));
    return { unlinked, notStocked };
  }
}
