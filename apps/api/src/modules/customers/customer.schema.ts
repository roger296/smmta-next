import { z } from 'zod';
import { paginationSchema } from '../../shared/utils/pagination.js';

// ============================================================
// Customer Zod Schemas
// ============================================================

export const createCustomerSchema = z.object({
  name: z.string().min(1).max(200),
  shortName: z.string().max(50).optional(),
  typeId: z.string().uuid().optional(),
  email: z.string().email().max(100).optional(),
  creditLimit: z.coerce.number().min(0).default(0),
  creditCurrencyCode: z.string().length(3).default('GBP'),
  creditTermDays: z.coerce.number().int().min(0).default(30),
  taxRatePercent: z.coerce.number().min(0).max(100).default(20),
  vatTreatment: z.enum([
    'STANDARD_VAT_20', 'REDUCED_VAT_5', 'ZERO_RATED',
    'EXEMPT', 'OUTSIDE_SCOPE', 'REVERSE_CHARGE', 'POSTPONED_VAT',
  ]).default('STANDARD_VAT_20'),
  vatRegistrationNumber: z.string().max(50).optional(),
  companyRegistrationNumber: z.string().max(50).optional(),
  countryCode: z.string().max(3).optional(),
  defaultRevenueAccountCode: z.string().max(10).optional(),
  warehouseId: z.string().uuid().optional(),
});

export const updateCustomerSchema = createCustomerSchema.partial();

export const customerQuerySchema = paginationSchema.extend({
  search: z.string().optional(),
  typeId: z.string().uuid().optional(),
});

export const customerContactSchema = z.object({
  name: z.string().max(200).optional(),
  jobTitle: z.string().max(100).optional(),
  officePhone: z.string().max(100).optional(),
  extension: z.string().max(20).optional(),
  mobile: z.string().max(50).optional(),
  email: z.string().email().max(100).optional(),
  skype: z.string().max(100).optional(),
  twitter: z.string().max(100).optional(),
});

export const customerAddressSchema = z.object({
  contactName: z.string().max(100).optional(),
  line1: z.string().max(255).optional(),
  line2: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  postCode: z.string().max(50).optional(),
  country: z.string().max(50).optional(),
  isDefault: z.boolean().default(false),
});

export const customerInvoiceAddressSchema = z.object({
  contactName: z.string().max(100).optional(),
  line1: z.string().max(255).optional(),
  line2: z.string().max(255).optional(),
  city: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  postCode: z.string().max(50).optional(),
  country: z.string().max(50).optional(),
  invoiceText: z.string().optional(),
});

export const customerNoteSchema = z.object({
  note: z.string().min(1),
  attachmentUrl: z.string().url().max(500).optional(),
  isMarked: z.boolean().default(false),
});

export const customerProductPriceSchema = z.object({
  productId: z.string().uuid(),
  price: z.coerce.number().min(0),
});

export const customerTypeSchema = z.object({
  name: z.string().min(1).max(150),
  isDefault: z.boolean().default(false),
});

export type CreateCustomerInput = z.input<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.input<typeof updateCustomerSchema>;
export type CustomerQueryInput = z.infer<typeof customerQuerySchema>;
