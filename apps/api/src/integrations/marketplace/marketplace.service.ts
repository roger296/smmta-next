import { eq, and, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { customers, customerDeliveryAddresses, customerContacts, customerOrders, products } from '../../db/schema/index.js';
import { OrderService } from '../../modules/orders/order.service.js';
import { CustomerService } from '../../modules/customers/customer.service.js';
import type { MarketplaceOrder, MarketplaceOrderLine, MarketplaceImportResult } from './marketplace.types.js';

/**
 * MarketplaceService — Normalises marketplace orders and imports them.
 *
 * Each channel-specific connector (Shopify, Amazon, etc.) fetches raw orders
 * and converts them into MarketplaceOrder[], then calls this service to
 * create them in the local database.
 *
 * Source: Libraries/DSB.Service/Orders/CustomerOrderServices.cs
 *   FormatShopifyOrder, SaveOrderFromSalesPlatform, InsertBulk,
 *   SetDefaultValues
 */
export class MarketplaceService {
  private db = getDb();
  private orderService = new OrderService();
  private customerService = new CustomerService();

  /**
   * Import an array of normalised marketplace orders.
   * - Deduplicates by thirdPartyOrderId
   * - Creates or matches customers
   * - Creates delivery addresses
   * - Maps SKUs to local products
   * - Creates orders via OrderService
   */
  async importOrders(
    companyId: string,
    userId: string,
    orders: MarketplaceOrder[],
  ): Promise<MarketplaceImportResult> {
    const result: MarketplaceImportResult = { imported: 0, skipped: 0, errors: [] };

    for (const mktOrder of orders) {
      try {
        // Skip duplicates
        const existing = await this.db.query.customerOrders.findFirst({
          where: and(
            eq(customerOrders.companyId, companyId),
            eq(customerOrders.thirdPartyOrderId, mktOrder.thirdPartyOrderId),
            isNull(customerOrders.deletedAt),
          ),
        });
        if (existing) {
          result.skipped++;
          continue;
        }

        // Find or create customer
        const customerId = await this.resolveCustomer(companyId, mktOrder);

        // Create delivery address
        const deliveryAddressId = await this.createDeliveryAddress(customerId, mktOrder);

        // Map lines to local products
        const mappedLines = await this.mapLinesToProducts(companyId, mktOrder.lines);

        if (mappedLines.length === 0) {
          result.errors.push({
            thirdPartyOrderId: mktOrder.thirdPartyOrderId,
            error: 'No lines could be mapped to local products',
          });
          continue;
        }

        // Create order via standard service
        await this.orderService.create(companyId, {
          customerId,
          deliveryAddressId,
          currencyCode: mktOrder.currencyCode,
          deliveryCharge: mktOrder.deliveryCharge,
          orderDate: mktOrder.orderDate,
          taxInclusive: mktOrder.taxInclusive,
          vatTreatment: 'STANDARD_VAT_20',
          sourceChannel: mktOrder.sourceChannel,
          paymentMethod: mktOrder.paymentMethod,
          customerOrderNumber: mktOrder.customerOrderNumber,
          integrationMetadata: mktOrder.rawData,
          lines: mappedLines,
        });

        // Update the order with thirdPartyOrderId (post-create patch)
        // The order was just created, find it by customer + date + order number
        const latestOrder = await this.db.query.customerOrders.findFirst({
          where: and(
            eq(customerOrders.companyId, companyId),
            eq(customerOrders.customerId, customerId),
            eq(customerOrders.sourceChannel, mktOrder.sourceChannel),
            isNull(customerOrders.deletedAt),
          ),
          orderBy: (o, { desc }) => [desc(o.createdAt)],
        });
        if (latestOrder) {
          await this.db
            .update(customerOrders)
            .set({ thirdPartyOrderId: mktOrder.thirdPartyOrderId })
            .where(eq(customerOrders.id, latestOrder.id));
        }

        result.imported++;
      } catch (err) {
        result.errors.push({
          thirdPartyOrderId: mktOrder.thirdPartyOrderId,
          error: (err as Error).message,
        });
      }
    }

    return result;
  }

  // ── Resolve or create customer from marketplace data ──

  private async resolveCustomer(companyId: string, order: MarketplaceOrder): Promise<string> {
    // Try to find by email first
    if (order.customer.email) {
      const existing = await this.customerService.getByEmail(order.customer.email, companyId);
      if (existing) return existing.id;
    }

    // Create new customer
    const customer = await this.customerService.create(companyId, {
      name: order.customer.name || 'Unknown Customer',
      email: order.customer.email,
      vatTreatment: 'STANDARD_VAT_20',
    });
    return customer.id;
  }

  // ── Create delivery address ──

  private async createDeliveryAddress(customerId: string, order: MarketplaceOrder): Promise<string | undefined> {
    if (!order.deliveryAddress.line1) return undefined;

    const [addr] = await this.db
      .insert(customerDeliveryAddresses)
      .values({
        customerId,
        contactName: order.deliveryAddress.contactName,
        line1: order.deliveryAddress.line1,
        line2: order.deliveryAddress.line2,
        city: order.deliveryAddress.city,
        region: order.deliveryAddress.region,
        postCode: order.deliveryAddress.postCode,
        country: order.deliveryAddress.country,
      })
      .returning();
    return addr.id;
  }

  // ── Map marketplace SKUs to local product IDs ──

  private async mapLinesToProducts(
    companyId: string,
    lines: MarketplaceOrderLine[],
  ): Promise<Array<{ productId: string; quantity: number; pricePerUnit: number; taxRate: number }>> {
    const mapped = [];

    for (const line of lines) {
      // Try to match by stock code / SKU
      let product = await this.db.query.products.findFirst({
        where: and(
          eq(products.companyId, companyId),
          eq(products.stockCode, line.sku),
          isNull(products.deletedAt),
        ),
      });

      // Try EAN match
      if (!product && line.sku) {
        product = await this.db.query.products.findFirst({
          where: and(
            eq(products.companyId, companyId),
            eq(products.ean, line.sku),
            isNull(products.deletedAt),
          ),
        });
      }

      if (product) {
        mapped.push({
          productId: product.id,
          quantity: line.quantity,
          pricePerUnit: line.pricePerUnit,
          taxRate: line.taxRate,
        });
      }
      // If no match, skip the line (error logged at caller level)
    }

    return mapped;
  }
}
