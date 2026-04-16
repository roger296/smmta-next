/**
 * Common types for all marketplace integrations.
 * Each connector normalises marketplace-specific order data into this shape,
 * which is then fed into OrderService.create().
 */

export interface MarketplaceOrder {
  /** Third-party order ID from the marketplace */
  thirdPartyOrderId: string;
  /** Channel this order came from */
  sourceChannel: 'SHOPIFY' | 'AMAZON' | 'EBAY' | 'ETSY' | 'WOOCOMMERCE';
  /** Customer info (will be looked up or created) */
  customer: {
    name: string;
    email?: string;
    phone?: string;
  };
  /** Delivery address */
  deliveryAddress: {
    contactName?: string;
    line1?: string;
    line2?: string;
    city?: string;
    region?: string;
    postCode?: string;
    country?: string;
  };
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
}
