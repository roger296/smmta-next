/**
 * Google Merchant Centre product feed — the pure half.
 *
 * Builds RSS 2.0 items with Google's `g:` attributes, one per sellable
 * product. `build-google-feed.ts` does the database reading and streams the
 * result to a file; everything here is a plain function so it can be tested
 * without a database.
 *
 * Rules worth knowing, from Google's product data specification:
 *   - Clothing needs a brand plus a barcode (`gtin`) or part number (`mpn`).
 *     With neither, the item must declare `identifier_exists: no` or Google
 *     rejects it.
 *   - Prices are what the customer pays, VAT included, which is what our
 *     `min_selling_price` holds.
 *   - `item_group_id` ties a range's sizes and colours together so Google
 *     shows one product with variants instead of ninety near-duplicates.
 *   - Availability must match the site. We publish `out_of_stock` items
 *     rather than dropping them, so an item that comes back in stock keeps
 *     its history instead of being treated as new.
 *   - `google_product_category` is deliberately not sent: Google assigns one
 *     itself, and a wrong id is worse than none. Our own taxonomy goes in
 *     `product_type`, which is free text.
 */

export type FeedAvailability = 'in_stock' | 'out_of_stock';

/** One product, already resolved against a channel: price, stock, delivery. */
export interface FeedProduct {
  /** Stable per shop. Our SKU where there is one, else the product id. */
  id: string;
  title: string;
  description: string | null;
  /** Absolute URL of the product page on the shop this feed is for. */
  link: string;
  imageLink: string | null;
  additionalImageLinks?: string[];
  /** Customer price, inc VAT, as a decimal string. */
  priceGbp: string | null;
  availability: FeedAvailability;
  brand: string | null;
  gtin: string | null;
  mpn: string | null;
  /** The range's slug: every size and colour of one product shares it. */
  itemGroupId: string | null;
  colour: string | null;
  size: string | null;
  /** Already normalised to Google's values. */
  gender: 'male' | 'female' | 'unisex' | null;
  ageGroup: 'newborn' | 'infant' | 'toddler' | 'kids' | 'adult' | null;
  /** Our category path, e.g. "Tops > Sweatshirts". */
  productTypePath: string | null;
  /** Delivery to the customer for this item, inc VAT, as a decimal string. */
  shippingGbp: string | null;
  shippingWeightKg: string | null;
}

/** Why an item can't go in the feed, or null when it can. */
export function feedSkipReason(p: {
  title?: string | null;
  priceGbp?: string | null;
  imageLink?: string | null;
  link?: string | null;
  imageLicenceExpiresAt?: Date | null;
  now?: Date;
}): 'no_title' | 'no_link' | 'no_price' | 'no_image' | 'image_licence_expired' | null {
  if (!p.title || !p.title.trim()) return 'no_title';
  if (!p.link || !p.link.trim()) return 'no_link';
  const price = Number.parseFloat(p.priceGbp ?? '');
  if (!Number.isFinite(price) || price <= 0) return 'no_price';
  if (!p.imageLink || !p.imageLink.trim()) return 'no_image';
  // Ralawise licenses its photography for a period. Feeding an image we no
  // longer have the right to show is a rights problem, not just a dead link.
  if (p.imageLicenceExpiresAt && p.imageLicenceExpiresAt.getTime() < (p.now ?? new Date()).getTime()) {
    return 'image_licence_expired';
  }
  return null;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Descriptions are stored as markdown; Google wants readable plain text. */
export function plainText(source: string | null | undefined, maxLength = 4_500): string {
  if (!source) return '';
  const text = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>]+/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\r/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

/** Supplier wording ("Mens", "Ladies", "Unisex") → Google's three values. */
export function googleGender(raw: string | null | undefined): FeedProduct['gender'] {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^(unisex|uni|both)/.test(s)) return 'unisex';
  if (/(women|ladies|lady|female|girls?)/.test(s)) return 'female';
  if (/(men|mens|male|boys?|gents?)/.test(s)) return 'male';
  return null;
}

/** Supplier wording → Google's five age groups. */
export function googleAgeGroup(raw: string | null | undefined): FeedProduct['ageGroup'] {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/new\s*born|newborn/.test(s)) return 'newborn';
  if (/baby|infant/.test(s)) return 'infant';
  if (/toddler/.test(s)) return 'toddler';
  if (/child|kid|junior|youth|boys?|girls?/.test(s)) return 'kids';
  if (/adult|men|women|ladies|unisex/.test(s)) return 'adult';
  return null;
}

function tag(name: string, value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  return `    <${name}>${escapeXml(String(value))}</${name}>\n`;
}

/** One `<item>` block. Returns '' for a product with no id — never a partial item. */
export function feedItemXml(p: FeedProduct): string {
  if (!p.id) return '';
  // Google's rule: with no barcode and no brand+part number, say so explicitly.
  const hasIdentifier = Boolean(p.gtin) || Boolean(p.brand && p.mpn);
  const extraImages = (p.additionalImageLinks ?? [])
    .filter((url) => url && url !== p.imageLink)
    .slice(0, 10)
    .map((url) => tag('g:additional_image_link', url))
    .join('');
  return (
    '  <item>\n' +
    tag('g:id', p.id) +
    tag('title', p.title.slice(0, 150)) +
    tag('description', plainText(p.description) || p.title.slice(0, 150)) +
    tag('link', p.link) +
    tag('g:image_link', p.imageLink) +
    extraImages +
    tag('g:availability', p.availability) +
    tag('g:price', p.priceGbp ? `${p.priceGbp} GBP` : null) +
    tag('g:condition', 'new') +
    tag('g:brand', p.brand) +
    tag('g:gtin', p.gtin) +
    tag('g:mpn', p.mpn) +
    (hasIdentifier ? '' : tag('g:identifier_exists', 'no')) +
    tag('g:item_group_id', p.itemGroupId) +
    tag('g:color', p.colour) +
    tag('g:size', p.size) +
    tag('g:gender', p.gender) +
    tag('g:age_group', p.ageGroup) +
    tag('g:product_type', p.productTypePath) +
    (p.shippingGbp
      ? '    <g:shipping>\n' +
        '      <g:country>GB</g:country>\n' +
        `      <g:price>${escapeXml(p.shippingGbp)} GBP</g:price>\n` +
        '    </g:shipping>\n'
      : '') +
    tag('g:shipping_weight', p.shippingWeightKg ? `${p.shippingWeightKg} kg` : null) +
    '  </item>\n'
  );
}

/**
 * One `<item>` for a supplemental feed: the id Google matches on, plus only
 * the attributes that move between nightly builds.
 *
 * Why this exists: Google suspends accounts whose price or availability
 * disagrees with the site, and our nightly file is stale long before the next
 * one — a full Ralawise stock sweep alone takes about 7 hours. A supplemental
 * feed fetched hourly corrects both without re-sending 100k full items.
 *
 * Only ever an update to an item the main feed already carries: an id Google
 * doesn't know is ignored, never created.
 */
export function feedStockItemXml(p: Pick<FeedProduct, 'id' | 'priceGbp' | 'availability'>): string {
  if (!p.id) return '';
  return (
    '  <item>\n' +
    tag('g:id', p.id) +
    tag('g:price', p.priceGbp ? `${p.priceGbp} GBP` : null) +
    tag('g:availability', p.availability) +
    '  </item>\n'
  );
}

export function feedOpen(shop: { title: string; link: string; description: string }): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n' +
    '  <channel>\n' +
    tag('title', shop.title).replace(/^ {4}/, '    ') +
    tag('link', shop.link) +
    tag('description', shop.description)
  );
}

export function feedClose(): string {
  return '  </channel>\n</rss>\n';
}
