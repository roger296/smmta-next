/**
 * Builds a Google Merchant Centre feed file for one storefront channel.
 *
 * The pure formatting lives in `google-feed.ts`; this is the half that reads
 * the catalogue. Both the nightly worker job and `scripts/build-google-feed.ts`
 * call `buildGoogleFeed`, so a feed built by hand is identical to the
 * scheduled one.
 *
 * Products are read in id order, 500 at a time, so a 100k catalogue never sits
 * in memory. The file is written to `<out>.tmp` and renamed at the end:
 * Google must never fetch a half-written feed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  categories,
  channels,
  productChannels,
  productGroups,
  products,
  suppliers,
  supplierProducts,
} from '../../db/schema/index.js';
import { getVariantAvailabilityBatch } from '../storefront/availability.js';
import {
  feedClose,
  feedItemXml,
  feedOpen,
  feedSkipReason,
  feedStockItemXml,
  googleAgeGroup,
  googleGender,
  type FeedProduct,
} from './google-feed.js';

/** `full` is the nightly feed; `stock` is the hourly supplemental one, which
 *  carries only id, price and availability for the same items. */
export type FeedMode = 'full' | 'stock';

const CHUNK = 500;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export interface BuildGoogleFeedOptions {
  companyId: string;
  /** Storefront channel slug, e.g. `clothes-shop`. */
  channelSlug: string;
  /** The shop's public origin; product links are built from it. */
  baseUrl: string;
  /** File to write. Its directory is created if missing. */
  outPath: string;
  /** Feed title. Defaults to the channel's display name. */
  shopName?: string | null;
  /** Delivery for warehouse items and suppliers with no charge of their own. */
  defaultShippingGbp?: string;
  /** Leave out-of-stock items out entirely. Default false: Google prefers
   *  them present and marked out_of_stock, so a returning item keeps its
   *  history instead of looking brand new. */
  excludeOutOfStock?: boolean;
  /** Stop after this many products (smoke tests). */
  limit?: number | null;
  /** Report the counts, write nothing. */
  dryRun?: boolean;
  /** `full` (default) or the hourly price-and-stock supplemental feed. */
  mode?: FeedMode;
}

export interface FeedBuildSummary {
  mode: FeedMode;
  channelSlug: string;
  outPath: string;
  considered: number;
  written: number;
  notOffered: number;
  outOfStockExcluded: number;
  /** Skip reason → count, e.g. `{ no_image: 12 }`. */
  skipped: Record<string, number>;
}

/** "Tops > Sweatshirts" for every category id, built once per run. */
async function categoryPaths(companyId: string): Promise<Map<string, string>> {
  const db = getDb();
  const rows = await db
    .select({ id: categories.id, name: categories.name, parentId: categories.parentId })
    .from(categories)
    .where(and(eq(categories.companyId, companyId), isNull(categories.deletedAt)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, string>();
  for (const row of rows) {
    const parent = row.parentId ? byId.get(row.parentId) : undefined;
    out.set(row.id, parent ? `${parent.name} > ${row.name}` : row.name);
  }
  return out;
}

export async function buildGoogleFeed(opts: BuildGoogleFeedOptions): Promise<FeedBuildSummary> {
  const db = getDb();
  const defaultShippingGbp = opts.defaultShippingGbp ?? '7.00';
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');

  const channel = await db.query.channels.findFirst({
    where: and(eq(channels.slug, opts.channelSlug), isNull(channels.deletedAt)),
  });
  if (!channel) {
    throw new Error(`No channel with slug=${opts.channelSlug}. Check "select slug from channels".`);
  }

  const paths = await categoryPaths(opts.companyId);
  const mode: FeedMode = opts.mode ?? 'full';
  const summary: FeedBuildSummary = {
    mode,
    channelSlug: opts.channelSlug,
    outPath: opts.outPath,
    considered: 0,
    written: 0,
    notOffered: 0,
    outOfStockExcluded: 0,
    skipped: {},
  };

  const tmpPath = `${opts.outPath}.tmp`;
  let stream: fs.WriteStream | null = null;
  if (!opts.dryRun) {
    fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
    stream = fs.createWriteStream(tmpPath, { encoding: 'utf8' });
    stream.write(
      feedOpen({
        title: opts.shopName ?? channel.displayName,
        link: baseUrl,
        description:
          mode === 'stock'
            ? `${opts.shopName ?? channel.displayName} price and availability`
            : `${opts.shopName ?? channel.displayName} product feed`,
      }),
    );
  }
  const write = (chunk: string): Promise<void> => {
    if (!stream) return Promise.resolve();
    if (!stream.write(chunk)) {
      return new Promise<void>((resolve) => stream!.once('drain', resolve));
    }
    return Promise.resolve();
  };

  const now = new Date();
  let cursor = ZERO_UUID;
  for (;;) {
    const rows = await db
      .select({
        id: products.id,
        slug: products.slug,
        name: products.name,
        stockCode: products.stockCode,
        brand: products.brand,
        ean: products.ean,
        mpn: products.manufacturerPartNumber,
        weight: products.weight,
        basePrice: products.minSellingPrice,
        heroImageUrl: products.heroImageUrl,
        galleryImageUrls: products.galleryImageUrls,
        shortDescription: products.shortDescription,
        longDescription: products.longDescription,
        attributes: products.attributes,
        colour: products.colour,
        categoryId: products.categoryId,
        imageLicenceExpiresAt: products.imageLicenceExpiresAt,
        groupSlug: productGroups.slug,
        groupHints: productGroups.categoryHints,
      })
      .from(products)
      .leftJoin(productGroups, eq(productGroups.id, products.groupId))
      .where(
        and(
          eq(products.companyId, opts.companyId),
          eq(products.isPublished, true),
          isNull(products.deletedAt),
          gt(products.id, cursor),
        ),
      )
      .orderBy(asc(products.id))
      .limit(CHUNK);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;
    const ids = rows.map((r) => r.id);

    // Channel scoping: a row for this channel decides; rows only for other
    // channels mean "not offered here"; no rows at all means offered.
    const pcRows = await db
      .select({
        productId: productChannels.productId,
        channelId: productChannels.channelId,
        isOffered: productChannels.isOffered,
        priceOverrideGbp: productChannels.priceOverrideGbp,
      })
      .from(productChannels)
      .where(and(inArray(productChannels.productId, ids), isNull(productChannels.deletedAt)));
    const channelRows = new Map<string, Array<(typeof pcRows)[number]>>();
    for (const r of pcRows) {
      const list = channelRows.get(r.productId);
      if (list) list.push(r);
      else channelRows.set(r.productId, [r]);
    }

    const availability = await getVariantAvailabilityBatch(opts.companyId, ids);

    // Delivery: the supplier an order would be routed to (lowest priority with
    // stock above its buffer), else the shop's standard rate.
    const spRows = await db
      .select({
        productId: supplierProducts.productId,
        priority: supplierProducts.priority,
        lastKnownStock: supplierProducts.lastKnownStock,
        stockBuffer: suppliers.stockBuffer,
        deliveryChargeGbp: suppliers.deliveryChargeGbp,
        isDropshipActive: suppliers.isDropshipActive,
      })
      .from(supplierProducts)
      .innerJoin(suppliers, eq(suppliers.id, supplierProducts.supplierId))
      .where(
        and(
          eq(supplierProducts.companyId, opts.companyId),
          inArray(supplierProducts.productId, ids),
          eq(supplierProducts.isActive, true),
          isNull(supplierProducts.deletedAt),
        ),
      );
    const candidates = new Map<string, Array<(typeof spRows)[number]>>();
    for (const r of spRows) {
      if (!r.isDropshipActive) continue;
      if ((r.lastKnownStock ?? 0) - r.stockBuffer <= 0) continue;
      const list = candidates.get(r.productId);
      if (list) list.push(r);
      else candidates.set(r.productId, [r]);
    }
    const shippingByProduct = new Map<string, string>();
    for (const [productId, list] of candidates) {
      list.sort((a, b) => a.priority - b.priority);
      shippingByProduct.set(productId, list[0]!.deliveryChargeGbp ?? defaultShippingGbp);
    }

    for (const row of rows) {
      if (opts.limit != null && summary.considered >= opts.limit) break;
      summary.considered++;

      const decisions = channelRows.get(row.id);
      const here = decisions?.find((d) => d.channelId === channel.id);
      const offered = decisions ? Boolean(here?.isOffered) : true;
      if (!offered) {
        summary.notOffered++;
        continue;
      }

      const stockState = availability.get(row.id)?.stockState ?? 'OUT_OF_STOCK';
      const inStock = stockState !== 'OUT_OF_STOCK';
      if (!inStock && opts.excludeOutOfStock) {
        summary.outOfStockExcluded++;
        continue;
      }

      const price = here?.priceOverrideGbp ?? row.basePrice ?? null;
      const link = row.slug ? `${baseUrl}/shop/p/${row.slug}` : null;
      const reason = feedSkipReason({
        title: row.name,
        link,
        priceGbp: price,
        imageLink: row.heroImageUrl,
        imageLicenceExpiresAt: row.imageLicenceExpiresAt,
        now,
      });
      if (reason) {
        summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
        continue;
      }

      const hints = row.groupHints ?? {};
      const attributes = row.attributes ?? {};
      const item: FeedProduct = {
        id: row.stockCode?.trim() || row.id,
        title: row.name,
        description: row.longDescription ?? row.shortDescription ?? null,
        link: link!,
        imageLink: row.heroImageUrl,
        additionalImageLinks: row.galleryImageUrls ?? [],
        priceGbp: price,
        availability: inStock ? 'in_stock' : 'out_of_stock',
        brand: row.brand,
        gtin: row.ean,
        mpn: row.mpn,
        itemGroupId: row.groupSlug,
        colour: row.colour ?? attributes.colour ?? null,
        size: attributes.size ?? null,
        gender: googleGender(hints.gender),
        // Clothing without an age group is adult wear; Google wants one.
        ageGroup: googleAgeGroup(hints.ageGroup) ?? 'adult',
        productTypePath: row.categoryId ? (paths.get(row.categoryId) ?? null) : null,
        shippingGbp: shippingByProduct.get(row.id) ?? defaultShippingGbp,
        shippingWeightKg: row.weight,
      };
      // The supplemental feed updates the same items, so it is built from the
      // same rows and the same filters: an item missing from the main feed
      // must not appear here either.
      await write(mode === 'stock' ? feedStockItemXml(item) : feedItemXml(item));
      summary.written++;
    }
    if (opts.limit != null && summary.considered >= opts.limit) break;
  }

  if (stream) {
    await write(feedClose());
    await new Promise<void>((resolve, reject) => {
      stream!.end((err?: NodeJS.ErrnoException | null) => (err ? reject(err) : resolve()));
    });
    fs.renameSync(tmpPath, opts.outPath);
  }
  return summary;
}

export interface FeedShop {
  channelSlug: string;
  baseUrl: string;
}

/**
 * Parse `GOOGLE_FEED_SHOPS`: comma-separated `channel-slug=https://origin`
 * pairs, e.g.
 *
 *   filament-store=https://filament.cleverdeals.net,clothes-shop=https://clothes.cleverdeals.net
 *
 * Malformed entries are dropped rather than failing the whole run: one
 * mistyped shop shouldn't stop the other shop's feed from being built.
 */
export function parseFeedShops(raw: string | null | undefined): FeedShop[] {
  const out: FeedShop[] = [];
  for (const part of (raw ?? '').split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const at = entry.indexOf('=');
    if (at <= 0) continue;
    const channelSlug = entry.slice(0, at).trim();
    const baseUrl = entry.slice(at + 1).trim().replace(/\/+$/, '');
    if (!channelSlug || !/^https?:\/\/.+/i.test(baseUrl)) continue;
    out.push({ channelSlug, baseUrl });
  }
  return out;
}

/** Where a shop's feed file is written: `<dir>/<channel-slug>.xml` for the
 *  nightly feed, `<dir>/<channel-slug>-stock.xml` for the hourly one. */
export function feedPathFor(dir: string, channelSlug: string, mode: FeedMode = 'full'): string {
  return path.join(dir, `${channelSlug}${mode === 'stock' ? '-stock' : ''}.xml`);
}
