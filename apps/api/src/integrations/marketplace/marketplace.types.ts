/**
 * Common types for all marketplace integrations.
 * Each connector normalises marketplace-specific order data into this shape,
 * which is then fed into OrderService.create().
 */

export interface MarketplaceOrder {
  /** Third-party order ID from the marketplace */
  thirdPartyOrderId: string;
  /** Channel this order came from */
  sourceChannel: 'SHOPIFY' | 'AMAZON' | 'EBAY' | 'ETSY' | 'WOOCOMMERCE' | 'CSV' | 'API' | 'MANUAL';
  /** Customer info (will be looked up or created) */
  customer: {
    name: string;
    email?: string;
    phone?: string;
  };
  /** Delivery address */
  deliveryAddress: MarketplaceAddress;
  /** Invoice address, when the source sends one separately. */
  invoiceAddress?: MarketplaceAddress;
  /** Courier the sender asked for, recorded on the order as sent. */
  courierName?: string;
  /**
   * Warehouse to fulfil from, by name (matched ignoring case). An unknown
   * name is an error: the order is not imported, so nothing is picked from
   * the wrong place.
   */
  warehouseName?: string;
  /** Order date from marketplace */
  orderDate: string; // YYYY-MM-DD
  /** Currency code */
  currencyCode: string;
  /** Line items */
  lines: MarketplaceOrderLine[];
  /** Delivery / shipping charge */
  deliveryCharge: number;
  /** Tax inclusive pricing? */
  taxInclusive: boolean;
  /** Payment method name */
  paymentMethod?: string;
  /** Customer-facing order number from marketplace */
  customerOrderNumber?: string;
  /** Raw marketplace-specific data for reference */
  rawData?: unknown;
}

export interface MarketplaceAddress {
  contactName?: string;
  /** Recipient phone; kept on a delivery address only, for the carrier. */
  phone?: string;
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postCode?: string;
  country?: string;
}

export interface MarketplaceOrderLine {
  /** SKU or product identifier from marketplace */
  sku: string;
  /** Product name (fallback if SKU not matched) */
  name: string;
  /** Quantity ordered */
  quantity: number;
  /** Price per unit */
  pricePerUnit: number;
  /** Tax rate percentage */
  taxRate: number;
  /** Marketplace-specific product ID */
  thirdPartyProductId?: string;
}

export interface MarketplaceConnectorConfig {
  channelName: string;
  apiKey?: string;
  apiSecret?: string;
  shopDomain?: string;
  accessToken?: string;
  refreshToken?: string;
  sellerId?: string;
  marketplaceId?: string;
}

export interface MarketplaceImportResult {
  imported: number;
  skipped: number;
  errors: Array<{ thirdPartyOrderId: string; error: string }>;
  /** The orders created, in input order, so a caller can answer with their numbers. */
  orders: MarketplaceImportedOrder[];
}

export interface MarketplaceImportedOrder {
  thirdPartyOrderId: string;
  orderId: string;
  orderNumber: string;
}
