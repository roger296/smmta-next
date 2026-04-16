import type { MarketplaceOrder, MarketplaceConnectorConfig } from './marketplace.types.js';

/**
 * ShopifyConnector — Fetches orders from Shopify REST API and normalises them.
 *
 * Source: Libraries/DSB.Service/Orders/CustomerOrderServices.cs
 *   FormatShopifyOrder, getSingleOrder, GetPendingOrders
 * Also: Libraries/DSB.Service/Integration/ShopifyAPIClient.cs
 */
export class ShopifyConnector {
  private shopDomain: string;
  private accessToken: string;

  constructor(config: MarketplaceConnectorConfig) {
    if (!config.shopDomain || !config.accessToken) {
      throw new Error('Shopify connector requires shopDomain and accessToken');
    }
    this.shopDomain = config.shopDomain;
    this.accessToken = config.accessToken;
  }

  /**
   * Fetch unfulfilled orders from Shopify.
   */
  async fetchOrders(sinceId?: string): Promise<MarketplaceOrder[]> {
    const url = `https://${this.shopDomain}/admin/api/2024-01/orders.json?status=any&fulfillment_status=unfulfilled${sinceId ? `&since_id=${sinceId}` : ''}`;

    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': this.accessToken },
    });
    if (!res.ok) throw new Error(`Shopify API error: ${res.status} ${res.statusText}`);

    const data = await res.json() as { orders: ShopifyOrder[] };
    return data.orders.map((o) => this.normalise(o));
  }

  private normalise(order: ShopifyOrder): MarketplaceOrder {
    const shipping = order.shipping_address;
    return {
      thirdPartyOrderId: String(order.id),
      sourceChannel: 'SHOPIFY',
      customer: {
        name: `${order.customer?.first_name ?? ''} ${order.customer?.last_name ?? ''}`.trim() || order.email || 'Shopify Customer',
        email: order.email,
        phone: order.phone ?? order.customer?.phone,
      },
      deliveryAddress: {
        contactName: shipping ? `${shipping.first_name ?? ''} ${shipping.last_name ?? ''}`.trim() : undefined,
        line1: shipping?.address1,
        line2: shipping?.address2,
        city: shipping?.city,
        region: shipping?.province,
        postCode: shipping?.zip,
        country: shipping?.country_code,
      },
      orderDate: order.created_at.slice(0, 10),
      currencyCode: order.currency,
      deliveryCharge: order.shipping_lines?.reduce((s, l) => s + parseFloat(l.price || '0'), 0) ?? 0,
      taxInclusive: order.taxes_included ?? false,
      paymentMethod: order.payment_gateway_names?.[0],
      customerOrderNumber: order.name,
      lines: (order.line_items || []).map((li) => ({
        sku: li.sku || li.variant_id?.toString() || '',
        name: li.title,
        quantity: li.quantity,
        pricePerUnit: parseFloat(li.price),
        taxRate: li.tax_lines?.[0] ? parseFloat(li.tax_lines[0].rate) * 100 : 20,
        thirdPartyProductId: li.product_id?.toString(),
      })),
      rawData: order,
    };
  }
}

// Minimal Shopify type stubs
interface ShopifyOrder {
  id: number;
  name: string;
  email?: string;
  phone?: string;
  created_at: string;
  currency: string;
  taxes_included?: boolean;
  payment_gateway_names?: string[];
  customer?: { first_name?: string; last_name?: string; phone?: string };
  shipping_address?: {
    first_name?: string; last_name?: string;
    address1?: string; address2?: string;
    city?: string; province?: string; zip?: string; country_code?: string;
  };
  shipping_lines?: Array<{ price: string }>;
  line_items?: Array<{
    sku?: string; variant_id?: number; product_id?: number;
    title: string; quantity: number; price: string;
    tax_lines?: Array<{ rate: string }>;
  }>;
}
