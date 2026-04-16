import type { MarketplaceOrder, MarketplaceConnectorConfig } from './marketplace.types.js';

/**
 * EbayConnector — Fetches orders from eBay REST Fulfillment API and normalises them.
 *
 * Source: Libraries/DSB.Service/Integration/EbayRestAPIHelper.cs
 *   Also: CustomerOrderServices.EbayOrderByID
 */
export class EbayConnector {
  private accessToken: string;

  constructor(config: MarketplaceConnectorConfig) {
    if (!config.accessToken) {
      throw new Error('eBay connector requires accessToken (OAuth user token)');
    }
    this.accessToken = config.accessToken;
  }

  /**
   * Fetch orders awaiting shipment from eBay Fulfillment API.
   */
  async fetchOrders(createdFrom?: string): Promise<MarketplaceOrder[]> {
    const filter = createdFrom
      ? `creationdate:[${createdFrom}T00:00:00.000Z..]`
      : `orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS}`;

    const url = `https://api.ebay.com/sell/fulfillment/v1/order?filter=${encodeURIComponent(filter)}&limit=50`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!res.ok) throw new Error(`eBay API error: ${res.status} ${res.statusText}`);

    const data = await res.json() as { orders?: EbayOrder[] };
    return (data.orders ?? []).map((o) => this.normalise(o));
  }

  private normalise(order: EbayOrder): MarketplaceOrder {
    const shipping = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
    const contact = shipping?.contactAddress;

    return {
      thirdPartyOrderId: order.orderId,
      sourceChannel: 'EBAY',
      customer: {
        name: shipping?.fullName ?? order.buyer?.username ?? 'eBay Buyer',
        email: shipping?.email,
      },
      deliveryAddress: {
        contactName: shipping?.fullName,
        line1: contact?.addressLine1,
        line2: contact?.addressLine2,
        city: contact?.city,
        region: contact?.stateOrProvince,
        postCode: contact?.postalCode,
        country: contact?.countryCode,
      },
      orderDate: order.creationDate.slice(0, 10),
      currencyCode: order.pricingSummary?.total?.currency ?? 'GBP',
      deliveryCharge: parseFloat(order.pricingSummary?.deliveryCost?.value ?? '0'),
      taxInclusive: true,
      paymentMethod: order.paymentSummary?.payments?.[0]?.paymentMethod,
      customerOrderNumber: order.orderId,
      lines: (order.lineItems ?? []).map((li) => ({
        sku: li.sku ?? li.legacyItemId ?? '',
        name: li.title,
        quantity: li.quantity,
        pricePerUnit: parseFloat(li.lineItemCost?.value ?? '0') / li.quantity,
        taxRate: 20,
        thirdPartyProductId: li.legacyItemId,
      })),
      rawData: order,
    };
  }
}

interface EbayOrder {
  orderId: string;
  creationDate: string;
  buyer?: { username?: string };
  pricingSummary?: {
    total?: { value: string; currency: string };
    deliveryCost?: { value: string };
  };
  paymentSummary?: { payments?: Array<{ paymentMethod?: string }> };
  fulfillmentStartInstructions?: Array<{
    shippingStep?: {
      shipTo?: {
        fullName?: string; email?: string;
        contactAddress?: {
          addressLine1?: string; addressLine2?: string;
          city?: string; stateOrProvince?: string; postalCode?: string; countryCode?: string;
        };
      };
    };
  }>;
  lineItems?: Array<{
    sku?: string; legacyItemId?: string; title: string;
    quantity: number; lineItemCost?: { value: string };
  }>;
}
