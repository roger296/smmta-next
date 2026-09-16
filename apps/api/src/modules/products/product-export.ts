/**
 * The full-catalogue CSV export behind the Export button on /products.
 *
 * One row per live product, one column per field that is actually stored —
 * asked for after the September venue testing, so head office can see the whole
 * catalogue at once instead of paging 25 at a time through the admin table.
 *
 * Two deliberate choices:
 *
 * - **Foreign keys are exported as a NAME and an ID, in that order.** A sheet
 *   full of UUIDs cannot be read by a person, and a sheet with only names
 *   cannot be matched back to a row. Both costs one column each and the export
 *   stops being a dead end either way.
 *
 * - **Image columns carry URLs, never ids.** `galleryImageUrls` (a jsonb array
 *   on the product) and the separate `product_images` table are each flattened
 *   to a ` | `-separated list of URLs, because a JSON blob in a spreadsheet
 *   cell is not something anybody can act on.
 *
 * Soft-deleted products are excluded — they are not in the catalogue, and the
 * admin table does not show them either.
 */
import { toCsv } from '../../shared/utils/csv.js';

/** A product row joined to the names of everything it points at. */
export interface ProductExportRow {
  [key: string]: unknown;
  id: string;
  name: string;
  manufacturerName: string | null;
  supplierName: string | null;
  categoryName: string | null;
  groupName: string | null;
  defaultWarehouseName: string | null;
  /** Resolved from `item_categories` — the export/import speak NAMES here. */
  itemCategoryName: string | null;
  /** URLs from the related `product_images` table, priority order. */
  imageUrls: string[];
}

/** `['a','b'] -> 'a | b'`, and an empty or absent list -> ''. */
function urlList(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.filter((v) => typeof v === 'string' && v.length > 0).join(' | ');
}

type Column = {
  header: string;
  /**
   * Which product column this cell reads. Recorded, not just closed over, so
   * `product-export.test.ts` can diff these against the real Drizzle table and
   * fail the build when a new column is added and nobody exports it. The
   * request was "all data set in all fields", and that only stays true if
   * something enforces it.
   */
  source: string;
  value: (row: ProductExportRow) => unknown;
};

/** Straight passthrough of a stored column. */
const field = (header: string, key: string): Column => ({
  header,
  source: key,
  value: (r) => r[key],
});

/**
 * Column order is the order somebody reads a product in: what it is, how it is
 * classified, who supplies it, how it is bought and counted, what it costs,
 * then the storefront/SEO/integration tail that most rows leave empty.
 */
export const PRODUCT_EXPORT_COLUMNS: ReadonlyArray<Column> = [
  // Identity
  field('Product ID', 'id'),
  field('Name', 'name'),
  field('Stock code', 'stockCode'),
  field('Barcode', 'barcode'),
  field('EAN', 'ean'),
  field('Slug', 'slug'),
  field('Manufacturer part number', 'manufacturerPartNumber'),
  // Classification
  field('Product type', 'productType'),
  field('Item kind', 'itemKind'),
  field('Is sold', 'isSold'),
  field('Is stocked', 'isStocked'),
  field('Is experience booking', 'isExperienceBooking'),
  field('Is published', 'isPublished'),
  // Who it relates to — name first, then the id that name resolves to
  field('Manufacturer', 'manufacturerName'),
  field('Manufacturer ID', 'manufacturerId'),
  field('Supplier', 'supplierName'),
  field('Supplier ID', 'supplierId'),
  field('Category', 'categoryName'),
  field('Category ID', 'categoryId'),
  field('Product group', 'groupName'),
  field('Product group ID', 'groupId'),
  // Item Category travels as a NAME, not an id: the operator edits this column
  // in a spreadsheet, and "Dry Stock" is something they can type. The import
  // resolves it back to a row case-insensitively.
  field('Item category', 'itemCategoryName'),
  field('Item category ID', 'itemCategoryId'),
  field('Default warehouse', 'defaultWarehouseName'),
  field('Default warehouse ID', 'defaultWarehouseId'),
  // Units of measure
  field('Stock UoM', 'stockUom'),
  field('Purchase UoM', 'purchaseUom'),
  field('Purchase pack size', 'purchasePackSize'),
  field('Pack description', 'packDescription'),
  field('Purchase to stock factor', 'purchaseToStockFactor'),
  field('Count quantum', 'countQuantum'),
  field('Stock check instruction', 'stockCheckInstruction'),
  // Money
  field('Expected next cost', 'expectedNextCost'),
  field('Min selling price', 'minSellingPrice'),
  field('Max selling price', 'maxSellingPrice'),
  // Physical / customs
  field('Weight', 'weight'),
  field('Length', 'length'),
  field('Width', 'width'),
  field('Height', 'height'),
  field('Country of origin', 'countryOfOrigin'),
  field('HS code', 'hsCode'),
  field('Require serial number', 'requireSerialNumber'),
  field('Require batch number', 'requireBatchNumber'),
  // Descriptive
  field('Description', 'description'),
  field('Short description', 'shortDescription'),
  field('Long description', 'longDescription'),
  field('Colour', 'colour'),
  field('Colour hex', 'colourHex'),
  field('Sort order in group', 'sortOrderInGroup'),
  { header: 'Attributes', source: 'attributes', value: (r) => r.attributes },
  // Images — URLs only, per the request
  field('Hero image URL', 'heroImageUrl'),
  {
    header: 'Gallery image URLs',
    source: 'galleryImageUrls',
    value: (r) => urlList(r.galleryImageUrls),
  },
  { header: 'Image URLs', source: 'imageUrls', value: (r) => urlList(r.imageUrls) },
  field('Reference image URL', 'referenceImageUrl'),
  field('Image capture store', 'imageCaptureStore'),
  field('Image licence expires at', 'imageLicenceExpiresAt'),
  // SEO
  field('SEO title', 'seoTitle'),
  field('SEO description', 'seoDescription'),
  { header: 'SEO keywords', source: 'seoKeywords', value: (r) => urlList(r.seoKeywords) },
  // Integration
  {
    header: 'Marketplace identifiers',
    source: 'marketplaceIdentifiers',
    value: (r) => r.marketplaceIdentifiers,
  },
  field('BumbleBee product ID', 'bumblebeeProductId'),
  field('Legacy ID', 'oldId'),
  // Audit
  field('Created at', 'createdAt'),
  field('Updated at', 'updatedAt'),
];

export function buildProductExportCsv(rows: readonly ProductExportRow[]): string {
  return toCsv(PRODUCT_EXPORT_COLUMNS, rows);
}

/** `products-2026-09-16.csv` — dated so successive exports don't overwrite. */
export function productExportFilename(now = new Date()): string {
  return `products-${now.toISOString().slice(0, 10)}.csv`;
}
