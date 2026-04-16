import type { MarketplaceOrder, MarketplaceConnectorConfig } from './marketplace.types.js';

/**
 * EtsyConnector — Fetches orders from Etsy Open API v3 and normalises them.
 *
 * Source: Libraries/DSB.Service/Integration/EtsyAPIHelper.cs
 *   Also: CustomerOrderServices.EtsyOrderByID
 */
export class EtsyConnector {
  private accessToken: string;
  private shopId: string;

  constructor(config: MarketplaceConnectorConfig) {
    if (!config.accessToken || !config.sellerId) {
      throw new Error('Etsy connector requires accessToken and sellerId (shopId)');
    }
    this.accessToken = config.accessToken;
    this.shopId = config.sellerId;
  }

  /**
   * Fetch open receipts (orders) from Etsy.
   */
  async fetchOrders(): Promise<MarketplaceOrder[]> {
    const url = `https://openapi.etsy.com/v3/application/shops/${this.shopId}/receipts?was_shipped=false&limit=25`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}`, 'x-api-key': this.accessToken },
    });
    if (!res.ok) throw new Error(`Etsy API error: ${res.status} ${res.statusText}`);

    const data = await res.json() as { results?: EtsyReceipt[] };
    return (data.results ?? []).map((r) => this.normalise(r));
  }

  private normalise(receipt: EtsyReceipt): MarketplaceOrder {
    return {
      thirdPartyOrderId: String(receipt.receipt_id),
      sourceChannel: 'ETSY',
      customer: {
        name: receipt.name ?? receipt.buyer_email ?? 'Etsy Buyer',
        email: receipt.buyer_email,
      },
      deliveryAddress: {
        contactName: receipt.name,
        line1: receipt.first_line,
        line2: receipt.second_line,
        city: receipt.city,
        region: receipt.state,
        postCode: receipt.zip,
        country: receipt.country_iso,
      },
      orderDate: new Date(receipt.create_timestamp * 1000).toISOString().slice(0, 10),
      currencyCode: receipt.transactions?.[0]?.currency_code ?? 'GBP',
      deliveryCharge: parseFloat(receipt.total_shipping_cost?.amount ?? '0') / 100,
      taxInclusive: true,
      paymentMethod: 'Etsy Payments',
      customerOrderNumber: String(receipt.receipt_id),
      lines: (receipt.transactions ?? []).map((t) => ({
        sku: t.sku ?? String(t.listing_id),
        name: t.title,
        quantity: t.quantity,
        pricePerUnit: parseFloat(t.price?.amount ?? '0') / 100,
        taxRate: 20,
        thirdPartyProductId: String(t.listing_id),
      })),
      rawData: receipt,
    };
  }
}

interface EtsyReceipt {
  receipt_id: number;
  name?: string;
  buyer_email?: string;
  create_timestamp: number;
  first_line?: string;
  second_line?: string;
  city?: string;
  state?: string;
  zip?: string;
  country_iso?: string;
  total_shipping_cost?: { amount: string };
  transactions?: Array<{
    listing_id: number;
    sku?: string;
    title: string;
    quantity: number;
    price?: { amount: string };
    currency_code?: string;
  }>;
}
