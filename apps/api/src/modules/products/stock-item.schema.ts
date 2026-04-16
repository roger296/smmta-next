import { z } from 'zod';
import { paginationSchema } from '../../shared/utils/pagination.js';

// ============================================================
// Stock Item Zod Schemas
// ============================================================

export const stockItemQuerySchema = paginationSchema.extend({
  productId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  status: z.enum(['IN_STOCK', 'ALLOCATED', 'SOLD', 'RETURNED', 'WRITTEN_OFF', 'IN_TRANSIT']).optional(),
  serialNumber: z.string().optional(),
});

export const stockAdjustmentSchema = z.object({
  productId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  type: z.enum(['ADD', 'REMOVE']),
  quantity: z.coerce.number().int().min(1),
  valuePerUnit: z.coerce.number().min(0),
  currencyCode: z.string().length(3).default('GBP'),
  serialNumbers: z.array(z.string()).optional(),
  batchId: z.string().optional(),
  locationIsle: z.string().max(50).optional(),
  locationShelf: z.string().max(50).optional(),
  locationBin: z.string().max(50).optional(),
  reason: z.string().min(1).max(500),
});

export const stockTransferSchema = z.object({
  stockItemIds: z.array(z.string().uuid()).min(1),
  fromWarehouseId: z.string().uuid(),
  toWarehouseId: z.string().uuid(),
  toLocationIsle: z.string().max(50).optional(),
  toLocationShelf: z.string().max(50).optional(),
  toLocationBin: z.string().max(50).optional(),
});

export const stockReportQuerySchema = z.object({
  warehouseId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  asAtDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export type StockItemQueryInput = z.infer<typeof stockItemQuerySchema>;
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;
export type StockTransferInput = z.infer<typeof stockTransferSchema>;
export type StockReportQueryInput = z.infer<typeof stockReportQuerySchema>;
