import { MarketplaceService } from '../../integrations/marketplace/marketplace.service.js';
import type { MarketplaceOrder, MarketplaceImportResult } from '../../integrations/marketplace/marketplace.types.js';

/**
 * CSVImportService — Parses CSV order data and imports via MarketplaceService.
 *
 * Source: Libraries/DSB.Service/Orders/CustomerOrderServices.cs
 *   FormatAndValidatedCsvCustomerOrders, InsertBulk
 *
 * Expected CSV columns:
 *   OrderNumber, CustomerName, CustomerEmail, DeliveryName, DeliveryLine1,
 *   DeliveryLine2, DeliveryCity, DeliveryRegion, DeliveryPostCode, DeliveryCountry,
 *   OrderDate, Currency, SKU, ProductName, Qty, UnitPrice, TaxRate,
 *   DeliveryCharge, PaymentMethod
 */
export class CSVImportService {
  private marketplaceService = new MarketplaceService();

  /**
   * Parse CSV text into MarketplaceOrder[] and import them.
   */
  async importFromCSV(
    companyId: string,
    userId: string,
    csvText: string,
  ): Promise<MarketplaceImportResult> {
    const orders = this.parseCSV(csvText);
    return this.marketplaceService.importOrders(companyId, userId, orders);
  }

  private parseCSV(csvText: string): MarketplaceOrder[] {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, '_'));

    // Group lines by order number
    const orderMap = new Map<string, {
      header: Record<string, string>;
      lines: Array<Record<string, string>>;
    }>();

    for (let i = 1; i < lines.length; i++) {
      const values = this.parseCSVLine(lines[i]);
      const row: Record<string, string> = {};
      headers.forEach((h, idx) => { row[h] = values[idx] ?? ''; });

      const orderNum = row.ordernumber || row.order_number || `CSV-${i}`;

      if (!orderMap.has(orderNum)) {
        orderMap.set(orderNum, { header: row, lines: [] });
      }
      orderMap.get(orderNum)!.lines.push(row);
    }

    // Convert to MarketplaceOrder[]
    const orders: MarketplaceOrder[] = [];

    for (const [orderNum, data] of orderMap) {
      const h = data.header;
      orders.push({
        thirdPartyOrderId: orderNum,
        sourceChannel: 'CSV' as any,
        customer: {
          name: h.customername || h.customer_name || 'CSV Customer',
          email: h.customeremail || h.customer_email,
        },
        deliveryAddress: {
          contactName: h.deliveryname || h.delivery_name,
          line1: h.deliveryline1 || h.delivery_line1,
          line2: h.deliveryline2 || h.delivery_line2,
          city: h.deliverycity || h.delivery_city,
          region: h.deliveryregion || h.delivery_region,
          postCode: h.deliverypostcode || h.delivery_post_code,
          country: h.deliverycountry || h.delivery_country,
        },
        orderDate: h.orderdate || h.order_date || new Date().toISOString().slice(0, 10),
        currencyCode: h.currency || 'GBP',
        deliveryCharge: parseFloat(h.deliverycharge || h.delivery_charge || '0'),
        taxInclusive: false,
        paymentMethod: h.paymentmethod || h.payment_method,
        customerOrderNumber: orderNum,
        lines: data.lines.map((l) => ({
          sku: l.sku || l.stock_code || '',
          name: l.productname || l.product_name || 'Unknown Product',
          quantity: parseFloat(l.qty || l.quantity || '1'),
          pricePerUnit: parseFloat(l.unitprice || l.unit_price || l.price || '0'),
          taxRate: parseFloat(l.taxrate || l.tax_rate || '20'),
        })),
      });
    }

    return orders;
  }

  /**
   * Parse a single CSV line handling quoted fields with commas.
   */
  private parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  }
}
