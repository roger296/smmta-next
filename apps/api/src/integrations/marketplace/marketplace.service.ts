import { eq, and, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import {
  customers,
  customerDeliveryAddresses,
  customerInvoiceAddresses,
  customerOrders,
  products,
  warehouses,
} from '../../db/schema/index.js';
import { OrderService } from '../../modules/orders/order.service.js';
import { CustomerService } from '../../modules/customers/customer.service.js';
import type {
  MarketplaceAddress,
  MarketplaceOrder,
  MarketplaceOrderLine,
  MarketplaceImportResult,
} from './marketplace.types.js';

/** The order cannot be imported as sent; the message says why. */
export class MarketplaceOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketplaceOrderError';
  }
}

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
    const result: MarketplaceImportResult = { imported: 0, skipped: 0, errors: [], orders: [] };

    for (const mktOrder of orders) {
      try {
        // Skip duplicates
        const existing = await this.findByReference(companyId, mktOrder.thirdPartyOrderId);
        if (existing) {
          result.skipped++;
          continue;
        }

        // Every line must name a product we sell. Dropping an unknown line
        // would ship an incomplete order with nothing to say so.
        const mappedLines = await this.mapLinesToProducts(companyId, mktOrder.lines);
        const warehouseId = await this.resolveWarehouse(companyId, mktOrder.warehouseName);

        // Find or create customer
        const customerId = await this.resolveCustomer(companyId, mktOrder);

        const deliveryAddressId = await this.createAddress(customerDeliveryAddresses, customerId, mktOrder.deliveryAddress);
        const invoiceAddressId = mktOrder.invoiceAddress
          ? await this.createAddress(customerInvoiceAddresses, customerId, mktOrder.invoiceAddress)
          : undefined;

        // Create order via standard service
        const order = await this.orderService.create(companyId, {
          customerId,
          deliveryAddressId,
          invoiceAddressId,
          warehouseId,
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
        if (!order) throw new Error('Order was not created');

        // The reference the sender knows the order by, and the courier they
        // asked for, are not part of the create input.
        await this.db
          .update(customerOrders)
          .set({
            thirdPartyOrderId: mktOrder.thirdPartyOrderId,
            courierName: mktOrder.courierName ?? null,
          })
          .where(eq(customerOrders.id, order.id));

        result.orders.push({
          thirdPartyOrderId: mktOrder.thirdPartyOrderId,
          orderId: order.id,
          orderNumber: order.orderNumber,
        });
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

  /** The order a sender's reference was imported as, if any. */
  async findByReference(companyId: string, thirdPartyOrderId: string) {
    return this.db.query.customerOrders.findFirst({
      where: and(
        eq(customerOrders.companyId, companyId),
        eq(customerOrders.thirdPartyOrderId, thirdPartyOrderId),
        isNull(customerOrders.deletedAt),
      ),
    });
  }

  // ── Resolve the warehouse by name ──

  private async resolveWarehouse(companyId: string, name: string | undefined): Promise<string | undefined> {
    if (!name) return undefined;
    const warehouse = await this.db.query.warehouses.findFirst({
      where: and(
        eq(warehouses.companyId, companyId),
        sql`lower(${warehouses.name}) = lower(${name})`,
        isNull(warehouses.deletedAt),
      ),
    });
    if (!warehouse) throw new MarketplaceOrderError(`Unknown warehouse "${name}"`);
    return warehouse.id;
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

  // ── Create an address row for the customer ──

  private async createAddress(
    table: typeof customerDeliveryAddresses | typeof customerInvoiceAddresses,
    customerId: string,
    address: MarketplaceAddress,
  ): Promise<string | undefined> {
    if (!address.line1) return undefined;

    const [addr] = await this.db
      .insert(table)
      .values({
        customerId,
        contactName: address.contactName,
        ...(table === customerDeliveryAddresses && address.phone ? { phone: address.phone } : {}),
        line1: address.line1,
        line2: address.line2,
        city: address.city,
        region: address.region,
        postCode: address.postCode,
        country: address.country,
      })
      .returning();
    return addr!.id;
  }

  // ── Map marketplace SKUs to local product IDs ──

  private async mapLinesToProducts(
    companyId: string,
    lines: MarketplaceOrderLine[],
  ): Promise<Array<{ productId: string; quantity: number; pricePerUnit: number; taxRate: number }>> {
    const mapped = [];
    const unknown: string[] = [];

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
      } else {
        unknown.push(line.sku || '(blank)');
      }
    }

    if (unknown.length > 0) {
      throw new MarketplaceOrderError(`Unknown product code(s): ${unknown.join(', ')}`);
    }
    if (mapped.length === 0) throw new MarketplaceOrderError('Order has no lines');

    return mapped;
  }
}
