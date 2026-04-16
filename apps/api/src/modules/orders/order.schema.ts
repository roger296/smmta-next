import { z } from 'zod';
import { paginationSchema } from '../../shared/utils/pagination.js';

// ============================================================
// Order Zod Schemas
// ============================================================

export const orderLineSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.coerce.number().min(0.01),
  pricePerUnit: z.coerce.number().min(0),
  taxRate: z.coerce.number().min(0).max(100).default(20),
});

export const createOrderSchema = z.object({
  customerId: z.string().uuid(),
  contactId: z.string().uuid().optional(),
  invoiceAddressId: z.string().uuid().optional(),
  deliveryAddressId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  currencyCode: z.string().length(3).default('GBP'),
  deliveryCharge: z.coerce.number().min(0).default(0),
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  taxInclusive: z.boolean().default(false),
  vatTreatment: z.enum([
    'STANDARD_VAT_20', 'REDUCED_VAT_5', 'ZERO_RATED',
    'EXEMPT', 'OUTSIDE_SCOPE', 'REVERSE_CHARGE', 'POSTPONED_VAT',
  ]).default('STANDARD_VAT_20'),
  sourceChannel: z.enum([
    'MANUAL', 'SHOPIFY', 'AMAZON', 'EBAY', 'ETSY', 'WOOCOMMERCE', 'CSV', 'API',
  ]).default('MANUAL'),
  paymentMethod: z.string().max(100).optional(),
  customerOrderNumber: z.string().max(100).optional(),
  factoryOrderNumber: z.string().max(100).optional(),
  integrationMetadata: z.any().optional(),
  lines: z.array(orderLineSchema).min(1),
});

export const updateOrderSchema = z.object({
  contactId: z.string().uuid().optional(),
  invoiceAddressId: z.string().uuid().optional(),
  deliveryAddressId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  deliveryCharge: z.coerce.number().min(0).optional(),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  paymentMethod: z.string().max(100).optional(),
  customerOrderNumber: z.string().max(100).optional(),
  trackingNumber: z.string().max(200).optional(),
  trackingLink: z.string().max(500).optional(),
  courierName: z.string().max(100).optional(),
});

export const orderQuerySchema = paginationSchema.extend({
  customerId: z.string().uuid().optional(),
  status: z.enum([
    'DRAFT', 'CONFIRMED', 'ALLOCATED', 'PARTIALLY_ALLOCATED',
    'BACK_ORDERED', 'READY_TO_SHIP', 'PARTIALLY_SHIPPED',
    'SHIPPED', 'INVOICED', 'COMPLETED', 'CANCELLED', 'ON_HOLD',
  ]).optional(),
  sourceChannel: z.enum([
    'MANUAL', 'SHOPIFY', 'AMAZON', 'EBAY', 'ETSY', 'WOOCOMMERCE', 'CSV', 'API',
  ]).optional(),
  search: z.string().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const orderStatusChangeSchema = z.object({
  status: z.enum([
    'DRAFT', 'CONFIRMED', 'ALLOCATED', 'PARTIALLY_ALLOCATED',
    'BACK_ORDERED', 'READY_TO_SHIP', 'PARTIALLY_SHIPPED',
    'SHIPPED', 'INVOICED', 'COMPLETED', 'CANCELLED', 'ON_HOLD',
  ]),
});

export const orderNoteSchema = z.object({
  note: z.string().min(1),
  attachmentUrl: z.string().url().max(500).optional(),
  isMarked: z.boolean().default(false),
  isPickingNote: z.boolean().default(false),
});

export const allocateStockSchema = z.object({
  warehouseId: z.string().uuid(),
});

export const createInvoiceFromOrderSchema = z.object({
  dateOfInvoice: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueDateOfInvoice: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const createCreditNoteSchema = z.object({
  dateOfCreditNote: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lines: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.coerce.number().min(0.01),
    pricePerUnit: z.coerce.number().min(0),
    taxRate: z.coerce.number().min(0).max(100).default(20),
    description: z.string().optional(),
  })).min(1),
});

export const allocatePaymentSchema = z.object({
  amount: z.coerce.number().min(0.01),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reference: z.string().optional(),
});

export type CreateOrderInput = z.input<typeof createOrderSchema>;
export type OrderQueryInput = z.infer<typeof orderQuerySchema>;
