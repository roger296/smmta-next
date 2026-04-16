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
