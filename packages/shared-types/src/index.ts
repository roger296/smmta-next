// ============================================================
// SMMTA-Next Shared Types
// ============================================================

// --- Enums ---

export enum OrderStatus {
  DRAFT = 'DRAFT',
  CONFIRMED = 'CONFIRMED',
  ALLOCATED = 'ALLOCATED',
  PARTIALLY_ALLOCATED = 'PARTIALLY_ALLOCATED',
  BACK_ORDERED = 'BACK_ORDERED',
  READY_TO_SHIP = 'READY_TO_SHIP',
  PARTIALLY_SHIPPED = 'PARTIALLY_SHIPPED',
  SHIPPED = 'SHIPPED',
  INVOICED = 'INVOICED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  ON_HOLD = 'ON_HOLD',
}

export enum SourceChannel {
  MANUAL = 'MANUAL',
  SHOPIFY = 'SHOPIFY',
  AMAZON = 'AMAZON',
  EBAY = 'EBAY',
  ETSY = 'ETSY',
  WOOCOMMERCE = 'WOOCOMMERCE',
  CSV = 'CSV',
  API = 'API',
}

export enum StockItemStatus {
  IN_STOCK = 'IN_STOCK',
  ALLOCATED = 'ALLOCATED',
  SOLD = 'SOLD',
  RETURNED = 'RETURNED',
  WRITTEN_OFF = 'WRITTEN_OFF',
  IN_TRANSIT = 'IN_TRANSIT',
}

export enum ProductType {
  PHYSICAL = 'PHYSICAL',
  SERVICE = 'SERVICE',
}

export enum InvoiceStatus {
  DRAFT = 'DRAFT',
  ISSUED = 'ISSUED',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PAID = 'PAID',
  OVERDUE = 'OVERDUE',
  VOIDED = 'VOIDED',
}

export enum CreditNoteStatus {
  DRAFT = 'DRAFT',
  ISSUED = 'ISSUED',
  ALLOCATED = 'ALLOCATED',
  VOIDED = 'VOIDED',
}

export enum PurchaseOrderDeliveryStatus {
  PENDING = 'PENDING',
  PARTIALLY_RECEIVED = 'PARTIALLY_RECEIVED',
  FULLY_RECEIVED = 'FULLY_RECEIVED',
  CANCELLED = 'CANCELLED',
}

export enum PurchaseOrderInvoiceStatus {
  NOT_INVOICED = 'NOT_INVOICED',
  PARTIALLY_INVOICED = 'PARTIALLY_INVOICED',
  FULLY_INVOICED = 'FULLY_INVOICED',
}

export enum GRNStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
}

export enum SupplierInvoiceStatus {
  DRAFT = 'DRAFT',
  APPROVED = 'APPROVED',
  PARTIALLY_PAID = 'PARTIALLY_PAID',
  PAID = 'PAID',
  VOIDED = 'VOIDED',
}

export enum AllocationItemType {
  INVOICE = 'INVOICE',
  CREDIT_NOTE = 'CREDIT_NOTE',
  PAYMENT = 'PAYMENT',
  SUPPLIER_INVOICE = 'SUPPLIER_INVOICE',
  SUPPLIER_CREDIT_NOTE = 'SUPPLIER_CREDIT_NOTE',
  SUPPLIER_PAYMENT = 'SUPPLIER_PAYMENT',
}

export enum StockAdjustmentType {
  ADD = 'ADD',
  REMOVE = 'REMOVE',
}

export enum SupplierAddressType {
  INVOICE = 'INVOICE',
  WAREHOUSE = 'WAREHOUSE',
}

// --- VAT Treatment (maps to Luca tax_code) ---

export enum VatTreatment {
  STANDARD_VAT_20 = 'STANDARD_VAT_20',
  REDUCED_VAT_5 = 'REDUCED_VAT_5',
  ZERO_RATED = 'ZERO_RATED',
  EXEMPT = 'EXEMPT',
  OUTSIDE_SCOPE = 'OUTSIDE_SCOPE',
  REVERSE_CHARGE = 'REVERSE_CHARGE',
  POSTPONED_VAT = 'POSTPONED_VAT',
}

// --- Luca GL Posting Types ---

export enum LucaTransactionType {
  CUSTOMER_INVOICE = 'CUSTOMER_INVOICE',
  CUSTOMER_CREDIT_NOTE = 'CUSTOMER_CREDIT_NOTE',
  CUSTOMER_PAYMENT = 'CUSTOMER_PAYMENT',
  SUPPLIER_INVOICE = 'SUPPLIER_INVOICE',
  SUPPLIER_CREDIT_NOTE = 'SUPPLIER_CREDIT_NOTE',
  SUPPLIER_PAYMENT = 'SUPPLIER_PAYMENT',
  MANUAL_JOURNAL = 'MANUAL_JOURNAL',
  BANK_RECEIPT = 'BANK_RECEIPT',
  BANK_PAYMENT = 'BANK_PAYMENT',
  BANK_TRANSFER = 'BANK_TRANSFER',
  BAD_DEBT_WRITE_OFF = 'BAD_DEBT_WRITE_OFF',
  PERIOD_END_ACCRUAL = 'PERIOD_END_ACCRUAL',
  DEPRECIATION = 'DEPRECIATION',
  YEAR_END_CLOSE = 'YEAR_END_CLOSE',
  PRIOR_PERIOD_ADJUSTMENT = 'PRIOR_PERIOD_ADJUSTMENT',
  FX_REVALUATION = 'FX_REVALUATION',
}

export enum GLPostingStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  RETRYING = 'RETRYING',
}

// --- Common Interfaces ---

export interface PaginationParams {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface CounterpartyRef {
  name: string;
  id: string;
}

export interface LucaJournalLine {
  account_code: string;
  amount: string;
  type: 'DEBIT' | 'CREDIT';
  description?: string;
}

export interface LucaPostTransactionRequest {
  transaction_type: LucaTransactionType;
  date: string; // YYYY-MM-DD
  period_id: string; // YYYY-MM
  description?: string;
  reference?: string;
  amount?: number;
  account_code?: string;
  tax_code?: string;
  counterparty?: CounterpartyRef;
  lines?: LucaJournalLine[];
  idempotency_key?: string;
  submitted_by?: string;
}
