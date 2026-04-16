import { z } from 'zod';
import { paginationSchema } from '../../shared/utils/pagination.js';

// ============================================================
// Purchase Order Zod Schemas
// ============================================================

export const poLineSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.coerce.number().min(0.01),
  pricePerUnit: z.coerce.number().min(0),
  taxRate: z.coerce.number().min(0).max(100).default(20),
  accountCode: z.string().max(10).optional(),
  expectedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const createPurchaseOrderSchema = z.object({
  supplierId: z.string().uuid(),
  contactId: z.string().uuid().optional(),
  addressId: z.string().uuid().optional(),
  deliveryWarehouseId: z.string().uuid().optional(),
  currencyCode: z.string().length(3).default('GBP'),
  deliveryCharge: z.coerce.number().min(0).default(0),
  vatTreatment: z.enum([
    'STANDARD_VAT_20', 'REDUCED_VAT_5', 'ZERO_RATED',
    'EXEMPT', 'OUTSIDE_SCOPE', 'REVERSE_CHARGE', 'POSTPONED_VAT',
  ]).default('STANDARD_VAT_20'),
  exchangeRate: z.coerce.number().min(0).default(1),
  expectedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lines: z.array(poLineSchema).min(1),
});

export const updatePurchaseOrderSchema = z.object({
  contactId: z.string().uuid().optional(),
  addressId: z.string().uuid().optional(),
  deliveryWarehouseId: z.string().uuid().optional(),
  deliveryCharge: z.coerce.number().min(0).optional(),
  vatTreatment: z.enum([
    'STANDARD_VAT_20', 'REDUCED_VAT_5', 'ZERO_RATED',
    'EXEMPT', 'OUTSIDE_SCOPE', 'REVERSE_CHARGE', 'POSTPONED_VAT',
  ]).optional(),
  exchangeRate: z.coerce.number().min(0).optional(),
  expectedDeliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  trackingNumber: z.string().max(200).optional(),
});

export const poQuerySchema = paginationSchema.extend({
  supplierId: z.string().uuid().optional(),
  deliveryStatus: z.enum(['PENDING', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CANCELLED']).optional(),
  invoicedStatus: z.enum(['NOT_INVOICED', 'PARTIALLY_INVOICED', 'FULLY_INVOICED']).optional(),
  search: z.string().optional(),
});

// ── GRN Book-In ──

export const grnLineSchema = z.object({
  productId: z.string().uuid(),
  quantityBookedIn: z.coerce.number().min(0.01),
  serialNumbers: z.array(z.string()).optional(),
  batchId: z.string().optional(),
  locationIsle: z.string().max(50).optional(),
  locationShelf: z.string().max(50).optional(),
  locationBin: z.string().max(50).optional(),
  valuePerUnit: z.coerce.number().min(0).optional(),
});

export const createGRNSchema = z.object({
  supplierDeliveryNoteNo: z.string().max(100).optional(),
  dateBookedIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lines: z.array(grnLineSchema).min(1),
});

// ── Supplier Invoice ──

export const supplierInvoiceLineSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.coerce.number().min(0.01),
  pricePerUnit: z.coerce.number().min(0),
  taxRate: z.coerce.number().min(0).max(100).default(20),
});

export const createSupplierInvoiceSchema = z.object({
  invoiceNumber: z.string().min(1).max(100),
  dateOfInvoice: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDateOfInvoice: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  deliveryCharge: z.coerce.number().min(0).default(0),
  isStockPurchase: z.boolean().default(true),
  accountCode: z.string().max(10).optional(),
  lines: z.array(supplierInvoiceLineSchema).min(1).optional(),
});

// ── Supplier Credit Note ──

export const createSupplierCreditNoteSchema = z.object({
  creditNoteNumber: z.string().min(1).max(100),
  dateOfCreditNote: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  creditNoteTotal: z.coerce.number().min(0.01),
  accountCode: z.string().max(10).optional(),
});

export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;
export type CreateGRNInput = z.infer<typeof createGRNSchema>;
export type CreateSupplierInvoiceInput = z.infer<typeof createSupplierInvoiceSchema>;
export type CreateSupplierCreditNoteInput = z.infer<typeof createSupplierCreditNoteSchema>;
