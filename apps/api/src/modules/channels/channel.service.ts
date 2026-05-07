/**
 * ChannelService — read the channels reference list and resolve
 * per-product channel rules (offered? what price?).
 *
 * Channel inheritance:
 *   - No row in `product_channels` for (productId, channelId)
 *     → product is offered on the channel at the base price
 *     (`products.min_selling_price`).
 *   - Row exists with `is_offered = false` → not offered.
 *   - Row exists with `is_offered = true` and
 *     `price_override_gbp` non-null → offered at the override.
 *   - Row exists with `is_offered = true` and
 *     `price_override_gbp` null → offered at the base price.
 *
 * The implicit "no row = offered at base" semantic is what keeps
 * existing products working without a backfill — the empty join
 * table is the back-compat default.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { channels, productChannels, products } from '../../db/schema/index.js';

export interface ChannelRow {
  id: string;
  slug: string;
  kind: 'STOREFRONT' | 'MARKETPLACE';
  displayName: string;
  isActive: boolean;
}

export interface ProductChannelRule {
  channelId: string;
  channelSlug: string;
  channelKind: 'STOREFRONT' | 'MARKETPLACE';
  channelDisplayName: string;
  isOffered: boolean;
  /** The price the product is sold at on this channel (override OR base). */
  priceGbp: string;
  /** The override stored in product_channels, or null if inheriting. */
  priceOverrideGbp: string | null;
}

export class ChannelService {
  private db = getDb();

  /** All active channels, ordered by display name. */
  async listActive(): Promise<ChannelRow[]> {
    const rows = await this.db.query.channels.findMany({
      where: and(eq(channels.isActive, true), isNull(channels.deletedAt)),
      orderBy: (c, { asc }) => [asc(c.kind), asc(c.displayName)],
    });
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      kind: r.kind,
      displayName: r.displayName,
      isActive: r.isActive,
    }));
  }

  async getBySlug(slug: string): Promise<ChannelRow | null> {
    const row = await this.db.query.channels.findFirst({
      where: and(eq(channels.slug, slug), isNull(channels.deletedAt)),
    });
    if (!row) return null;
    return {
      id: row.id,
      slug: row.slug,
      kind: row.kind,
      displayName: row.displayName,
      isActive: row.isActive,
    };
  }

  /** Resolve the full channel matrix for a single product. Always returns
   *  one row per known active channel — channels with no explicit rule are
   *  filled in with the implicit "offered at base price" defaults. */
  async getRulesForProduct(productId: string, basePriceGbp: string): Promise<ProductChannelRule[]> {
    const all = await this.listActive();
    const overrides = await this.db.query.productChannels.findMany({
      where: and(eq(productChannels.productId, productId), isNull(productChannels.deletedAt)),
    });
    const overrideByChannelId = new Map(overrides.map((o) => [o.channelId, o]));

    return all.map((c) => {
      const o = overrideByChannelId.get(c.id);
      const isOffered = o ? o.isOffered : true;
      const priceOverrideGbp = o?.priceOverrideGbp ?? null;
      return {
        channelId: c.id,
        channelSlug: c.slug,
        channelKind: c.kind,
        channelDisplayName: c.displayName,
        isOffered,
        priceGbp: priceOverrideGbp ?? basePriceGbp,
        priceOverrideGbp,
      };
    });
  }

  /** Bulk upsert of rules for a product. Rows that match the implicit
   *  default (offered = true, override = null) are deleted so the join
   *  table stays sparse and the implicit semantic continues to apply. */
  async upsertRulesForProduct(
    productId: string,
    rules: Array<{
      channelId: string;
      isOffered: boolean;
      priceOverrideGbp: string | null;
    }>,
  ): Promise<void> {
    if (rules.length === 0) return;

    const isDefault = (r: { isOffered: boolean; priceOverrideGbp: string | null }) =>
      r.isOffered && (r.priceOverrideGbp === null || r.priceOverrideGbp === undefined);

    const toUpsert = rules.filter((r) => !isDefault(r));
    const toDelete = rules.filter(isDefault).map((r) => r.channelId);

    if (toDelete.length > 0) {
      await this.db
        .delete(productChannels)
        .where(
          and(
            eq(productChannels.productId, productId),
            inArray(productChannels.channelId, toDelete),
          ),
        );
    }

    for (const r of toUpsert) {
      await this.db
        .insert(productChannels)
        .values({
          productId,
          channelId: r.channelId,
          isOffered: r.isOffered,
          priceOverrideGbp: r.priceOverrideGbp,
        })
        .onConflictDoUpdate({
          target: [productChannels.productId, productChannels.channelId],
          set: {
            isOffered: r.isOffered,
            priceOverrideGbp: r.priceOverrideGbp,
            updatedAt: new Date(),
          },
        });
    }
  }

  /**
   * Resolve the price a product is sold at on a given channel. Falls back
   * to the base price when no override is present. Returns `null` when the
   * product is not offered on that channel.
   */
  async getChannelPrice(productId: string, channelId: string): Promise<string | null> {
    const product = await this.db.query.products.findFirst({
      where: eq(products.id, productId),
      columns: { id: true, minSellingPrice: true },
    });
    if (!product) return null;
    const basePrice = product.minSellingPrice ?? '0';

    const rule = await this.db.query.productChannels.findFirst({
      where: and(
        eq(productChannels.productId, productId),
        eq(productChannels.channelId, channelId),
        isNull(productChannels.deletedAt),
      ),
    });
    if (!rule) return basePrice;
    if (!rule.isOffered) return null;
    return rule.priceOverrideGbp ?? basePrice;
  }
}
