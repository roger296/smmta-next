/**
 * Manual API types for Phase A.
 * Run `npm run gen:api-types` (with the API running locally) to regenerate
 * this from the live OpenAPI spec in later phases.
 */

export interface Customer {
  id: string;
  companyId: string;
  code: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  customerTypeId: string | null;
  accountManagerId: string | null;
  creditLimit: string;
  creditCurrencyCode: string;
  creditTermDays: number;
  taxRatePercent: string;
  vatTreatment: string;
  vatNumber: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CustomerListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  customerTypeId?: string;
  isActive?: boolean;
}
