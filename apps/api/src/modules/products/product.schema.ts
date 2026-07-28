import { z } from 'zod';
import { paginationSchema } from '../../shared/utils/pagination.js';

// ============================================================
// Product Zod Schemas (validation + OpenAPI generation)
// ============================================================

export const marketplaceIdentifiersSchema = z.object({
  sellerSkus: z.array(z.string()).optional(),
  asins: z.array(z.string()).optional(),
  fnskus: z.array(z.string()).optional(),
  shopifyProductId: z.string().optional(),
  ebayItemId: z.string().optional(),
  etsyListingId: z.string().optional(),
}).optional();

// ----------------------------------------------------------------
// Storefront fields — see apps/api/src/db/schema/products.ts.
// All fields are optional at the schema level; products can be
// created without any storefront content and remain unpublished
// (`is_published` defaults to false in the DB).
// ----------------------------------------------------------------

export const storefrontProductFieldsSchema = z.object({
  groupId: z.string().uuid().nullable().optional(),
  colour: z.string().max(80).nullable().optional(),
  colourHex: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'colourHex must be #RRGGBB').nullable().optional(),
  slug: z.string().min(1).max(200).nullable().optional(),
  shortDescription: z.string().max(280).nullable().optional(),
  longDescription: z.string().nullable().optional(),
  heroImageUrl: z.string().url().max(500).nullable().optional(),
  galleryImageUrls: z.array(z.string().url()).nullable().optional(),
  seoTitle: z.string().max(70).nullable().optional(),
  seoDescription: z.string().max(160).nullable().optional(),
  seoKeywords: z.array(z.string()).nullable().optional(),
  isPublished: z.boolean().optional(),
  sortOrderInGroup: z.coerce.number().int().min(0).optional(),
});

// ----------------------------------------------------------------
// Auto-Stock item model + units of measure (spec §A3). All optional;
// DB defaults apply (item_kind RETAIL, is_sold/is_stocked true,
// stock_uom 'each', pack size / factor 1).
// ----------------------------------------------------------------

export const autoStockProductFieldsSchema = z.object({
  itemKind: z.enum(['MERCH', 'RETAIL', 'INGREDIENT', 'PACKAGING']).optional(),
  isSold: z.boolean().optional(),
  isStocked: z.boolean().optional(),
  barcode: z.string().max(64).nullable().optional(),
  bumblebeeProductId: z.string().uuid().nullable().optional(),
  referenceImageUrl: z.string().url().max(500).nullable().optional(),
  imageCaptureStore: z.string().max(200).nullable().optional(),
  stockUom: z.string().min(1).max(20).optional(),
  purchaseUom: z.string().max(20).nullable().optional(),
  purchasePackSize: z.coerce.number().positive().optional(),
  purchaseToStockFactor: z.coerce.number().positive().optional(),
});

export const createProductSchema = z.object({
  name: z.string().min(1).max(500),
  stockCode: z.string().max(100).optional(),
  manufacturerId: z.string().uuid().optional(),
  manufacturerPartNumber: z.string().max(100).optional(),
  description: z.string().optional(),
  expectedNextCost: z.coerce.number().min(0).default(0),
  minSellingPrice: z.coerce.number().min(0).optional(),
  maxSellingPrice: z.coerce.number().min(0).optional(),
  ean: z.string().max(50).optional(),
  productType: z.enum(['PHYSICAL', 'SERVICE']).default('PHYSICAL'),
  requireSerialNumber: z.boolean().default(false),
  requireBatchNumber: z.boolean().default(false),
  weight: z.coerce.number().min(0).optional(),
  length: z.coerce.number().min(0).optional(),
  width: z.coerce.number().min(0).optional(),
  height: z.coerce.number().min(0).optional(),
  countryOfOrigin: z.string().max(3).optional(),
  hsCode: z.string().max(20).optional(),
  supplierId: z.string().uuid().optional(),
  defaultWarehouseId: z.string().uuid().optional(),
  marketplaceIdentifiers: marketplaceIdentifiersSchema,
}).merge(storefrontProductFieldsSchema).merge(autoStockProductFieldsSchema);

// ----------------------------------------------------------------
// Product Groups — Zod schemas for storefront content management.
// ----------------------------------------------------------------

export const storefrontGroupFieldsSchema = z.object({
  slug: z.string().min(1).max(200).nullable().optional(),
  shortDescription: z.string().max(280).nullable().optional(),
  longDescription: z.string().nullable().optional(),
  heroImageUrl: z.string().url().max(500).nullable().optional(),
  galleryImageUrls: z.array(z.string().url()).nullable().optional(),
  seoTitle: z.string().max(70).nullable().optional(),
  seoDescription: z.string().max(160).nullable().optional(),
  seoKeywords: z.array(z.string()).nullable().optional(),
  isPublished: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
});

export const createProductGroupSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().nullable().optional(),
  groupType: z.string().max(50).nullable().optional(),
}).merge(storefrontGroupFieldsSchema);

export const updateProductGroupSchema = createProductGroupSchema.partial();

export const updateProductSchema = createProductSchema.partial();

const ITEM_KINDS = ['MERCH', 'RETAIL', 'INGREDIENT', 'PACKAGING'] as const;

export const productQuerySchema = paginationSchema.extend({
  search: z.string().optional(),
  /** Repeatable — ?itemKind=INGREDIENT&itemKind=PACKAGING. Normalised to an
   *  array so a single value and a list behave the same. */
  itemKind: z
    .union([z.string(), z.array(z.string())])
    .optional()
    // Accept ?k=a&k=b, a single value, OR a comma-joined "a,b". Being liberal
    // here matters: the strict version rejected the comma form with a 400 that
    // the UI rendered as "no matches", which reads as an empty catalogue
    // rather than a broken request.
    .transform((v) => {
      if (v == null) return undefined;
      const parts = (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(','));
      const valid = parts
        .map((x) => x.trim().toUpperCase())
        .filter((x) => ITEM_KINDS.includes(x as (typeof ITEM_KINDS)[number]));
      return valid.length ? (valid as Array<(typeof ITEM_KINDS)[number]>) : undefined;
    }),
  categoryId: z.string().uuid().optional(),
  manufacturerId: z.string().uuid().optional(),
  productType: z.enum(['PHYSICAL', 'SERVICE']).optional(),
  supplierId: z.string().uuid().optional(),
});

export const productImageSchema = z.object({
  imageUrl: z.string().url().max(500),
  priority: z.coerce.number().int().min(0).default(0),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ProductQueryInput = z.infer<typeof productQuerySchema>;
export type CreateProductGroupInput = z.infer<typeof createProductGroupSchema>;
export type UpdateProductGroupInput = z.infer<typeof updateProductGroupSchema>;
