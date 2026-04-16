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
});

export const updateProductSchema = createProductSchema.partial();

export const productQuerySchema = paginationSchema.extend({
  search: z.string().optional(),
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
