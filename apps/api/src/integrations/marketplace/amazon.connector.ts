import type { MarketplaceOrder, MarketplaceConnectorConfig } from './marketplace.types.js';

/**
 * AmazonConnector — Fetches orders from Amazon SP-API and normalises them.
 *
 * Source: Libraries/DSB.Service/Integration/AmazonSPAPIService.cs
 *   Also: CustomerOrderServices.AmazonSpApiOrderByID
 *
 * NOTE: Amazon SP-API requires OAuth token exchange and role assumption via
 * AWS STS. This connector handles the normalisation layer; the actual
 * SP-API auth flow should use the @sp-api-sdk package or equivalent.
 */
export class AmazonConnector {
  private sellerId: string;
  private marketplaceId: string;
  private refreshToken: string;

  constructor(config: MarketplaceConnectorConfig) {
    if (!config.sellerId || !config.marketplaceId || !config.refreshToken) {
      throw new Error('Amazon connector requires sellerId, marketplaceId, and refreshToken');
    }
    this.sellerId = config.sellerId;
    this.marketplaceId = config.marketplaceId;
    this.refreshToken = config.refreshToken;
  }

  /**
   * Fetch unshipped orders from Amazon SP-API.
   * In production, this would use the Orders API v0 endpoint.
   */
  async fetchOrders(createdAfter?: string): Promise<MarketplaceOrder[]> {
    // Placeholder — in production, implement SP-API OAuth + getOrders
    // const client = new SellingPartnerAPI({ ... });
    // const response = await client.callAPI({ operation: 'getOrders', ... });
    throw new Error(
      'Amazon SP-API integration requires @sp-api-sdk configuration. ' +
      'Set up OAuth credentials and implement getOrders endpoint.'
    );
  }

  /**
   * Normalise a raw Amazon order into the common MarketplaceOrder format.
   */
  normalise(order: AmazonOrder): MarketplaceOrder {
    const shipping = order.ShippingAddress;
    return {
      thirdPartyOrderId: order.AmazonOrderId,
      sourceChannel: 'AMAZON',
      customer: {
        name: order.BuyerInfo?.BuyerName ?? shipping?.Name ?? 'Amazon Customer',
        email: order.BuyerInfo?.BuyerEmail,
      },
      deliveryAddress: {
        contactName: shipping?.Name,
        line1: shipping?.AddressLine1,
        line2: shipping?.AddressLine2,
        city: shipping?.City,
        region: shipping?.StateOrRegion,
        postCode: shipping?.PostalCode,
        country: shipping?.CountryCode,
      },
      orderDate: order.PurchaseDate.slice(0, 10),
      currencyCode: order.OrderTotal?.CurrencyCode ?? 'GBP',
      deliveryCharge: 0, // Amazon handles shipping separately
      taxInclusive: true, // Amazon UK orders are tax-inclusive
      paymentMethod: order.PaymentMethod,
      customerOrderNumber: order.AmazonOrderId,
      lines: (order.OrderItems || []).map((item) => ({
        sku: item.SellerSKU,
        name: item.Title,
        quantity: item.QuantityOrdered,
        pricePerUnit: parseFloat(item.ItemPrice?.Amount ?? '0') / item.QuantityOrdered,
        taxRate: 20, // UK default — should check order tax data
        thirdPartyProductId: item.ASIN,
      })),
      rawData: order,
    };
  }
}

// Minimal Amazon SP-API type stubs
interface AmazonOrder {
  AmazonOrderId: string;
  PurchaseDate: string;
  OrderStatus: string;
  PaymentMethod?: string;
  OrderTotal?: { CurrencyCode: string; Amount: string };
  BuyerInfo?: { BuyerName?: string; BuyerEmail?: string };
  ShippingAddress?: {
    Name?: string; AddressLine1?: string; AddressLine2?: string;
    City?: string; StateOrRegion?: string; PostalCode?: string; CountryCode?: string;
  };
  OrderItems?: Array<{
    SellerSKU: string; ASIN: string; Title: string;
    QuantityOrdered: number;
    ItemPrice?: { Amount: string; CurrencyCode: string };
  }>;
}
