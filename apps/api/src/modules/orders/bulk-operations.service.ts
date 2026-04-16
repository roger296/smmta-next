import { OrderService } from './order.service.js';
import { InvoiceService } from './invoice.service.js';

/**
 * BulkOperationsService — Bulk ship, bulk invoice, bulk status change.
 *
 * Source: Libraries/DSB.Service/Orders/CustomerOrderServices.cs
 *   OrderStatusUpdate (List<CustomerOrder>), GenerateBulkShipmentDocuments
 */
export class BulkOperationsService {
  private orderService = new OrderService();
  private invoiceService = new InvoiceService();

  /**
   * Bulk change order status (e.g., mark multiple as SHIPPED).
   */
  async bulkStatusChange(
    companyId: string,
    orderIds: string[],
    status: string,
  ): Promise<BulkResult> {
    const result: BulkResult = { succeeded: 0, failed: 0, errors: [] };

    for (const orderId of orderIds) {
      try {
        await this.orderService.changeStatus(orderId, companyId, status);
        result.succeeded++;
      } catch (err) {
        result.failed++;
        result.errors.push({ id: orderId, error: (err as Error).message });
      }
    }
    return result;
  }

  /**
   * Bulk ship orders — marks as SHIPPED with tracking info.
   */
  async bulkShip(
    companyId: string,
    orders: Array<{
      orderId: string;
      trackingNumber?: string;
      trackingLink?: string;
      courierName?: string;
    }>,
  ): Promise<BulkResult> {
    const result: BulkResult = { succeeded: 0, failed: 0, errors: [] };

    for (const item of orders) {
      try {
        // Update tracking info first
        if (item.trackingNumber || item.trackingLink || item.courierName) {
          await this.orderService.update(item.orderId, companyId, {
            trackingNumber: item.trackingNumber,
            trackingLink: item.trackingLink,
            courierName: item.courierName,
          });
        }
        // Change status to SHIPPED
        await this.orderService.changeStatus(item.orderId, companyId, 'SHIPPED');
        result.succeeded++;
      } catch (err) {
        result.failed++;
        result.errors.push({ id: item.orderId, error: (err as Error).message });
      }
    }
    return result;
  }

  /**
   * Bulk create invoices from orders — each triggers GL posting.
   */
  async bulkInvoice(
    companyId: string,
    userId: string,
    orderIds: string[],
    dateOfInvoice?: string,
  ): Promise<BulkResult> {
    const result: BulkResult = { succeeded: 0, failed: 0, errors: [] };

    for (const orderId of orderIds) {
      try {
        await this.invoiceService.createFromOrder(orderId, companyId, userId, {
          dateOfInvoice,
        });
        result.succeeded++;
      } catch (err) {
        result.failed++;
        result.errors.push({ id: orderId, error: (err as Error).message });
      }
    }
    return result;
  }

  /**
   * Bulk allocate stock to multiple orders.
   */
  async bulkAllocate(
    companyId: string,
    orderIds: string[],
    warehouseId: string,
  ): Promise<BulkResult> {
    const result: BulkResult = { succeeded: 0, failed: 0, errors: [] };

    for (const orderId of orderIds) {
      try {
        await this.orderService.allocateStock(orderId, companyId, warehouseId);
        result.succeeded++;
      } catch (err) {
        result.failed++;
        result.errors.push({ id: orderId, error: (err as Error).message });
      }
    }
    return result;
  }
}

interface BulkResult {
  succeeded: number;
  failed: number;
  errors: Array<{ id: string; error: string }>;
}
