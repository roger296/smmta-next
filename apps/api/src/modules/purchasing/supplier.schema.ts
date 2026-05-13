import { z } from 'zod';
import { paginationSchema } from '../../shared/utils/pagination.js';

// ============================================================
// Supplier Zod Schemas
// ============================================================

export const createSupplierSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.string().max(100).optional(),
  email: z.string().email().max(200).optional(),
  accountsEmail: z.string().email().max(200).optional(),
  website: z.string().url().max(500).optional(),
  currencyCode: z.string().length(3).default('GBP'),
  creditLimit: z.coerce.number().min(0).default(0),
  creditTermDays: z.coerce.number().int().min(0).default(30),
  taxRatePercent: z.coerce.number().min(0).max(100).default(20),
  vatTreatment: z.enum([
    'STANDARD_VAT_20', 'REDUCED_VAT_5', 'ZERO_RATED',
    'EXEMPT', 'OUTSIDE_SCOPE', 'REVERSE_CHARGE', 'POSTPONED_VAT',
  ]).default('STANDARD_VAT_20'),
  vatRegistrationNumber: z.string().max(50).optional(),
  countryCode: z.string().max(3).optional(),
  leadTimeDays: z.coerce.number().int().min(0).optional(),
  defaultExpenseAccountCode: z.string().max(10).optional(),
});

export const updateSupplierSchema = createSupplierSchema.partial();

// ============================================================
// Drop-shipping fields — patched in via the same endpoints
// ------------------------------------------------------------
// Validation rules for the integration columns added to `suppliers`
// in §A. Treated as optional patches: an empty object is a no-op.
// `apiKeyPlaintext` is what the SPA submits; the route handler
// encrypts it before persisting. A blank/missing value means
// "leave the existing key untouched" (the SPA never displays the
// stored key).
// ============================================================

export const dropshipSupplierSchema = z.object({
  slug: z.string().min(1).max(100).optional(),
  connectorKind: z.enum(['NONE', 'UNEEK', 'RALAWISE', 'STUB']).optional(),
  apiBaseUrl: z.string().url().max(500).nullable().optional(),
  apiKeyPlaintext: z.string().min(1).max(1000).optional(),
  apiAuthScheme: z.string().max(20).optional(),
  isDropshipActive: z.boolean().optional(),
  pollIntervalMinutes: z.coerce.number().int().min(5).max(60 * 24).optional(),
  dispatchSlaMinDays: z.coerce.number().int().min(0).max(365).optional(),
  dispatchSlaMaxDays: z.coerce.number().int().min(0).max(365).optional(),
  showSupplierNameToCustomers: z.boolean().optional(),
});

export type DropshipSupplierInput = z.infer<typeof dropshipSupplierSchema>;

export const testConnectionSchema = z.object({
  supplierSku: z.string().min(1).max(200),
});

export const upsertSupplierMappingsSchema = z.object({
  mappings: z
    .array(
      z.object({
        supplierId: z.string().uuid(),
        supplierSku: z.string().min(1).max(200),
        costGbp: z.string().regex(/^\d+(\.\d{1,2})?$/, 'costGbp must be a decimal string'),
        priority: z.coerce.number().int().min(0).max(10_000).default(100),
        isActive: z.boolean().default(true),
      }),
    )
    .max(50),
});

export const supplierQuerySchema = paginationSchema.extend({
  search: z.string().optional(),
  type: z.string().optional(),
});

export const supplierContactSchema = z.object({
  name: z.string().max(200).optional(),
  jobTitle: z.string().max(100).optional(),
  phone: z.string().max(100).optional(),
  extension: z.string().max(20).optional(),
  mobile: z.string().max(50).optional(),
  email: z.string().email().max(100).optional(),
  skype: z.string().max(100).optional(),
});

export const supplierAddressSchema = z.object({
  contactName: z.string().max(100).optional(),
  line1: z.string().max(255).optional(),
  line2: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  postCode: z.string().max(50).optional(),
  country: z.string().max(50).optional(),
  addressType: z.enum(['INVOICE', 'WAREHOUSE']).default('INVOICE'),
});

export const supplierNoteSchema = z.object({
  note: z.string().min(1),
  attachmentUrl: z.string().url().max(500).optional(),
  isMarked: z.boolean().default(false),
});

export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;
export type SupplierQueryInput = z.infer<typeof supplierQuerySchema>;
