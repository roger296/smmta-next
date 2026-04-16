/**
 * Manual API types.
 * Run `npm run gen:api-types` with the API running locally to regenerate
 * from the live OpenAPI spec in later phases.
 */

export type VatTreatment =
  | 'STANDARD_VAT_20'
  | 'REDUCED_VAT_5'
  | 'ZERO_RATED'
  | 'EXEMPT'
  | 'OUTSIDE_SCOPE'
  | 'REVERSE_CHARGE'
  | 'POSTPONED_VAT';

export type ProductType = 'PHYSICAL' | 'SERVICE';

// ============================================================
// Customers
// ============================================================

export interface Customer {
  id: string;
  companyId: string;
  code: string | null;
  name: string;
  shortName: string | null;
  typeId: string | null;
  email: string | null;
  creditLimit: string;
  creditCurrencyCode: string;
  creditTermDays: number;
  taxRatePercent: string;
  vatTreatment: VatTreatment;
  vatRegistrationNumber: string | null;
  companyRegistrationNumber: string | null;
  countryCode: string | null;
  defaultRevenueAccountCode: string | null;
  warehouseId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerContact {
  id: string;
  customerId: string;
  name: string | null;
  jobTitle: string | null;
  officePhone: string | null;
  extension: string | null;
  mobile: string | null;
  email: string | null;
  skype: string | null;
  twitter: string | null;
}

export interface CustomerDeliveryAddress {
  id: string;
  customerId: string;
  contactName: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postCode: string | null;
  country: string | null;
  isDefault: boolean;
}

export interface CustomerInvoiceAddress {
  id: string;
  customerId: string;
  contactName: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postCode: string | null;
  country: string | null;
  invoiceText: string | null;
}

export interface CustomerNote {
  id: string;
  customerId: string;
  note: string;
  attachmentUrl: string | null;
  isMarked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerType {
  id: string;
  name: string;
  isDefault: boolean;
}

// ============================================================
// Suppliers
// ============================================================

export interface Supplier {
  id: string;
  companyId: string;
  code: string | null;
  name: string;
  type: string | null;
  email: string | null;
  accountsEmail: string | null;
  website: string | null;
  currencyCode: string;
  creditLimit: string;
  creditTermDays: number;
  taxRatePercent: string;
  vatTreatment: VatTreatment;
  vatRegistrationNumber: string | null;
  countryCode: string | null;
  leadTimeDays: number | null;
  defaultExpenseAccountCode: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierContact {
  id: string;
  supplierId: string;
  name: string | null;
  jobTitle: string | null;
  phone: string | null;
  extension: string | null;
  mobile: string | null;
  email: string | null;
  skype: string | null;
}

export interface SupplierAddress {
  id: string;
  supplierId: string;
  contactName: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postCode: string | null;
  country: string | null;
  addressType: 'INVOICE' | 'WAREHOUSE';
}

export interface SupplierNote {
  id: string;
  supplierId: string;
  note: string;
  attachmentUrl: string | null;
  isMarked: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// Products
// ============================================================

export interface Product {
  id: string;
  companyId: string;
  name: string;
  stockCode: string | null;
  manufacturerId: string | null;
  manufacturerPartNumber: string | null;
  description: string | null;
  expectedNextCost: string;
  minSellingPrice: string | null;
  maxSellingPrice: string | null;
  ean: string | null;
  productType: ProductType;
  requireSerialNumber: boolean;
  requireBatchNumber: boolean;
  weight: string | null;
  length: string | null;
  width: string | null;
  height: string | null;
  countryOfOrigin: string | null;
  hsCode: string | null;
  supplierId: string | null;
  defaultWarehouseId: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProductImage {
  id: string;
  productId: string;
  imageUrl: string;
  priority: number;
}

export interface StockLevel {
  warehouseId: string;
  warehouseName: string;
  available: number;
  allocated: number;
  total: number;
}

// ============================================================
// Reference data
// ============================================================

export interface Warehouse {
  id: string;
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postCode: string | null;
  country: string | null;
  isDefault: boolean;
}

export interface Category {
  id: string;
  name: string;
}

export interface Manufacturer {
  id: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  website: string | null;
  customerSupportPhone: string | null;
  customerSupportEmail: string | null;
  techSupportPhone: string | null;
  techSupportEmail: string | null;
}

// ============================================================
// Orders
// ============================================================

export type OrderStatus =
  | 'DRAFT'
  | 'CONFIRMED'
  | 'ALLOCATED'
  | 'PARTIALLY_ALLOCATED'
  | 'BACK_ORDERED'
  | 'READY_TO_SHIP'
  | 'PARTIALLY_SHIPPED'
  | 'SHIPPED'
  | 'INVOICED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'ON_HOLD';

export type SourceChannel =
  | 'MANUAL'
  | 'SHOPIFY'
  | 'AMAZON'
  | 'EBAY'
  | 'ETSY'
  | 'WOOCOMMERCE'
  | 'CSV'
  | 'API';

export interface OrderLine {
  id: string;
  orderId: string;
  productId: string;
  productName?: string;
  quantity: string;
  pricePerUnit: string;
  taxRate: string;
  lineTotal: string;
  lineTax: string;
}

export interface Order {
  id: string;
  companyId: string;
  orderNumber: string;
  customerId: string;
  customerName?: string;
  contactId: string | null;
  invoiceAddressId: string | null;
  deliveryAddressId: string | null;
  warehouseId: string | null;
  currencyCode: string;
  deliveryCharge: string;
  subtotal: string;
  taxAmount: string;
  total: string;
  cogs: string;
  margin: string;
  orderDate: string;
  deliveryDate: string | null;
  taxInclusive: boolean;
  vatTreatment: VatTreatment;
  sourceChannel: SourceChannel;
  status: OrderStatus;
  paymentMethod: string | null;
  customerOrderNumber: string | null;
  factoryOrderNumber: string | null;
  trackingNumber: string | null;
  trackingLink: string | null;
  courierName: string | null;
  lines?: OrderLine[];
  createdAt: string;
  updatedAt: string;
}

export interface OrderNote {
  id: string;
  orderId: string;
  note: string;
  isMarked: boolean;
  isPickingNote: boolean;
  createdAt: string;
}

// ============================================================
// Invoices & Credit Notes
// ============================================================

export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'VOIDED';

export interface InvoiceLine {
  id: string;
  invoiceId: string;
  productId: string;
  productName?: string;
  quantity: string;
  pricePerUnit: string;
  taxRate: string;
  lineTotal: string;
  lineTax: string;
}

export interface Invoice {
  id: string;
  companyId: string;
  invoiceNumber: string;
  orderId: string;
  customerId: string;
  customerName?: string;
  status: InvoiceStatus;
  dateOfInvoice: string;
  dueDateOfInvoice: string | null;
  subtotal: string;
  taxAmount: string;
  total: string;
  paidAmount: string;
  outstandingAmount: string;
  lines?: InvoiceLine[];
  createdAt: string;
  updatedAt: string;
}

export interface CreditNote {
  id: string;
  creditNoteNumber: string;
  invoiceId: string;
  dateOfCreditNote: string;
  total: string;
  createdAt: string;
}

export interface Payment {
  id: string;
  invoiceId: string;
  amount: string;
  paymentDate: string;
  reference: string | null;
  createdAt: string;
}

// ============================================================
// Purchase Orders
// ============================================================

export type PODeliveryStatus = 'PENDING' | 'PARTIALLY_RECEIVED' | 'FULLY_RECEIVED' | 'CANCELLED';
export type POInvoicedStatus = 'NOT_INVOICED' | 'PARTIALLY_INVOICED' | 'FULLY_INVOICED';

export interface POLine {
  id: string;
  purchaseOrderId: string;
  productId: string;
  productName?: string;
  quantity: string;
  quantityReceived: string;
  quantityInvoiced: string;
  pricePerUnit: string;
  taxRate: string;
  lineTotal: string;
  expectedDeliveryDate: string | null;
}

export interface PurchaseOrder {
  id: string;
  companyId: string;
  poNumber: string;
  supplierId: string;
  supplierName?: string;
  deliveryWarehouseId: string | null;
  currencyCode: string;
  deliveryCharge: string;
  subtotal: string;
  taxAmount: string;
  total: string;
  vatTreatment: VatTreatment;
  exchangeRate: string;
  expectedDeliveryDate: string | null;
  deliveryStatus: PODeliveryStatus;
  invoicedStatus: POInvoicedStatus;
  trackingNumber: string | null;
  lines?: POLine[];
  createdAt: string;
  updatedAt: string;
}

export interface GRNLine {
  id: string;
  grnId: string;
  productId: string;
  productName?: string;
  quantityBookedIn: string;
  serialNumbers: string[] | null;
  valuePerUnit: string;
}

export interface GRN {
  id: string;
  grnNumber: string;
  purchaseOrderId: string;
  supplierDeliveryNoteNo: string | null;
  dateBookedIn: string;
  lines?: GRNLine[];
  createdAt: string;
}

export interface SupplierInvoice {
  id: string;
  invoiceNumber: string;
  supplierId: string;
  supplierName?: string;
  purchaseOrderId: string | null;
  dateOfInvoice: string;
  dueDateOfInvoice: string | null;
  subtotal: string;
  taxAmount: string;
  total: string;
  paidAmount: string;
  outstandingAmount: string;
  status: InvoiceStatus;
  createdAt: string;
}
