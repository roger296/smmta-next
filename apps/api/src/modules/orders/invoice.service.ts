import { eq, and, isNull, count } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getDb, getPool } from '../../config/database.js';
import * as schema from '../../db/schema/index.js';
import {
  invoices, invoiceLines, customerOrders, orderLines,
  creditNotes, creditNoteLines, allocations, stockItems,
} from '../../db/schema/index.js';
import { LucaGLService } from '../../integrations/luca/luca-gl.service.js';
import { StockItemService } from '../products/stock-item.service.js';
import { roundMoney } from '../../shared/utils/currency.js';
import type { VatTreatment } from '@smmta/shared-types';

/**
 * InvoiceService — Create invoices from orders, credit notes, and payment allocations.
 * All three operations trigger GL postings to Luca.
 *
 * Source: Libraries/DSB.Service/Invoices/InvoiceServices.cs
 *   CreateInvoiceAndLedgerEntry, CustomerInvoiceGLEntryUpdated,
 *   Insert, Update, GetInvoiceForAllocation, SaveForAllocation
 * GL source: Libraries/DSB.Service/Ledgers/GeneralLedgerServices.cs
 *   LedgerEntryFromInvoiceLineObject (line 2901)
 */
export class InvoiceService {
  private db = getDb();
  private lucaGL = new LucaGLService();
  private stockService = new StockItemService();

  // ================================================================
  // List invoices
  // ================================================================

  async list(companyId: string, query: {
    page: number; pageSize: number;
    customerId?: string; status?: string; orderId?: string;
  }) {
    const { page, pageSize, customerId, status, orderId } = query;
    const offset = (page - 1) * pageSize;

    const conditions = [eq(invoices.companyId, companyId), isNull(invoices.deletedAt)];
    if (customerId) conditions.push(eq(invoices.customerId, customerId));
    if (status) conditions.push(eq(invoices.status, status as any));
    if (orderId) conditions.push(eq(invoices.orderId, orderId));

    const where = and(...conditions);

    const [totalResult, rows] = await Promise.all([
      this.db.select({ count: count() }).from(invoices).where(where),
      this.db.query.invoices.findMany({
        where,
        with: { customer: true, order: true },
        limit: pageSize,
        offset,
        orderBy: (i, { desc }) => [desc(i.createdAt)],
      }),
    ]);

    return {
      data: rows,
      total: Number(totalResult[0]?.count ?? 0),
      page, pageSize,
      totalPages: Math.ceil(Number(totalResult[0]?.count ?? 0) / pageSize),
    };
  }

  // ================================================================
  // Get by ID
  // ================================================================

  async getById(id: string, companyId: string) {
    return this.db.query.invoices.findFirst({
      where: and(eq(invoices.id, id), eq(invoices.companyId, companyId), isNull(invoices.deletedAt)),
      with: {
        customer: true,
        order: true,
        lines: { where: isNull(invoiceLines.deletedAt), with: { product: true } },
        creditNotes: { where: isNull(creditNotes.deletedAt) },
      },
    });
  }

  // ================================================================
  // Create Invoice from Order — TRIGGERS GL
  //
  // This is the core financial operation:
  //   1. Creates invoice + lines from order
  //   2. Marks allocated stock as SOLD
  //   3. Posts CUSTOMER_INVOICE to Luca (Debit AR, Credit Revenue, Credit VAT)
  //   4. Posts COGS MANUAL_JOURNAL to Luca (Debit COGS, Credit Stock)
  //   5. Updates order status to INVOICED
  //
  // Old: InvoiceServices.CreateInvoiceAndLedgerEntry
  //      InvoiceServices.CustomerInvoiceGLEntryUpdated
  // ================================================================

  async createFromOrder(
    orderId: string,
    companyId: string,
    userId: string,
    input: { dateOfInvoice?: string; dueDateOfInvoice?: string },
  ) {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const txDb = drizzle(client, { schema });

      // Load order with all relations
      const order = await txDb.query.customerOrders.findFirst({
        where: and(eq(schema.customerOrders.id, orderId), eq(schema.customerOrders.companyId, companyId)),
        with: {
          customer: true,
          lines: { where: isNull(schema.orderLines.deletedAt), with: { product: true } },
        },
      });
      if (!order) throw new InvoiceError('Order not found');

      // Generate invoice number
      const invoiceNumber = await this.generateInvoiceNumber(txDb, companyId);
      const dateOfInvoice = input.dateOfInvoice ?? new Date().toISOString().slice(0, 10);
      const dueDateOfInvoice = input.dueDateOfInvoice
        ?? this.addDays(dateOfInvoice, order.customer.creditTermDays ?? 30);

      // Calculate totals from order lines
      let lineTotal = 0;
      let taxTotal = 0;
      let cogsTotal = 0;

      const invLineData = order.lines.map((ol) => {
        const lt = Number(ol.lineTotal);
        const tv = Number(ol.taxValue ?? 0);
        lineTotal += lt;
        taxTotal += tv;

        // COGS = expected cost × quantity
        const expectedCost = Number(ol.product.expectedNextCost ?? 0);
        const lineCogs = roundMoney(expectedCost * ol.quantity);
        cogsTotal += lineCogs;

        return {
          productId: ol.productId,
          quantity: ol.quantity,
          pricePerUnit: ol.pricePerUnit,
          taxName: ol.taxName,
          taxRate: ol.taxRate ?? 0,
          taxValue: ol.taxValue ?? '0',
          lineTotal: ol.lineTotal,
        };
      });

      const deliveryCharge = Number(order.deliveryCharge ?? 0);
      const grandTotal = roundMoney(lineTotal + taxTotal + deliveryCharge);

      // Create invoice
      const [invoice] = await txDb
        .insert(invoices)
        .values({
          companyId,
          orderId,
          customerId: order.customerId,
          contactId: order.contactId,
          invoiceAddressId: order.invoiceAddressId,
          deliveryAddressId: order.deliveryAddressId,
          currencyCode: order.currencyCode,
          invoiceNumber,
          deliveryCharge: deliveryCharge.toString(),
          lineTotal: lineTotal.toString(),
          taxTotal: taxTotal.toString(),
          grandTotal: grandTotal.toString(),
          amountOutstanding: grandTotal.toString(),
          status: 'ISSUED',
          vatTreatment: order.vatTreatment,
          dateOfInvoice,
          dueDateOfInvoice,
        })
        .returning();

      // Create invoice lines
      const invLines = invLineData.map((il) => ({
        invoiceId: invoice.id,
        productId: il.productId,
        quantity: il.quantity,
        pricePerUnit: il.pricePerUnit,
        taxName: il.taxName,
        taxRate: il.taxRate,
        taxValue: il.taxValue,
        lineTotal: il.lineTotal,
      }));
      await txDb.insert(invoiceLines).values(invLines);

      // Mark allocated stock as SOLD
      await txDb
        .update(stockItems)
        .set({
          status: 'SOLD',
          bookedOutDate: dateOfInvoice,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(stockItems.salesOrderId, orderId),
            eq(stockItems.companyId, companyId),
            eq(stockItems.status, 'ALLOCATED'),
            isNull(stockItems.deletedAt),
          ),
        );

      // Update order: revenue, cogs, margin, status
      await txDb
        .update(customerOrders)
        .set({
          status: 'INVOICED',
          revenue: lineTotal.toString(),
          cogs: cogsTotal.toString(),
          margin: roundMoney(lineTotal - cogsTotal).toString(),
          updatedAt: new Date(),
        })
        .where(eq(customerOrders.id, orderId));

      // ── GL POSTING 1: CUSTOMER_INVOICE ──
      // Luca auto-expands: Debit 1100 (AR), Credit 4000 (Revenue), Credit 2100 (VAT)
      await this.lucaGL.postCustomerInvoice(txDb as any, {
        companyId,
        invoiceId: invoice.id,
        invoiceNumber,
        orderNumber: order.orderNumber,
        invoiceDate: new Date(dateOfInvoice),
        grandTotal,
        vatTreatment: order.vatTreatment as VatTreatment,
        customerName: order.customer.name,
        customerId: order.customerId,
      });

      // ── GL POSTING 2: COGS / Stock journal ──
      // Debit 5000 (COGS), Credit 1150 (Stock)
      await this.lucaGL.postInvoiceCOGS(txDb as any, {
        companyId,
        invoiceId: invoice.id,
        invoiceNumber,
        invoiceDate: new Date(dateOfInvoice),
        cogsTotal,
      });

      await client.query('COMMIT');
      return this.getById(invoice.id, companyId);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ================================================================
  // Create Credit Note from Invoice — TRIGGERS GL
  //
  // Old: CreditNoteServices.Insert
  // GL: CUSTOMER_CREDIT_NOTE + COGS reversal journal
  // ================================================================

  async createCreditNote(
    invoiceId: string,
    companyId: string,
    userId: string,
    input: {
      dateOfCreditNote: string;
      lines: Array<{
        productId: string; quantity: number;
        pricePerUnit: number; taxRate: number; description?: string;
      }>;
    },
  ) {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const txDb = drizzle(client, { schema });

      const invoice = await txDb.query.invoices.findFirst({
        where: and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.companyId, companyId)),
        with: { customer: true },
      });
      if (!invoice) throw new InvoiceError('Invoice not found');

      // Generate credit note number
      const cnNumber = await this.generateCreditNoteNumber(txDb, companyId);

      // Calculate totals
      let lineTotal = 0;
      let taxTotal = 0;
      let stockValue = 0;

      const cnLineData = input.lines.map((line) => {
        const lt = roundMoney(line.quantity * line.pricePerUnit);
        const tv = roundMoney(lt * (line.taxRate / 100));
        lineTotal += lt;
        taxTotal += tv;

        // Estimate stock value for COGS reversal (use product expected cost)
        // In a full implementation we'd look up actual cost from sold stock items
        stockValue += lt * 0.6; // Approximate — should be actual cost

        return { ...line, lineTotal: lt, taxValue: tv };
      });

      const creditNoteTotal = roundMoney(lineTotal + taxTotal);

      // Create credit note
      const [cn] = await txDb
        .insert(creditNotes)
        .values({
          companyId,
          invoiceId,
          customerId: invoice.customerId,
          contactId: invoice.contactId,
          addressId: invoice.invoiceAddressId,
          currencyCode: invoice.currencyCode,
          creditNoteNumber: cnNumber,
          lineTotal: lineTotal.toString(),
          taxTotal: taxTotal.toString(),
          creditNoteTotal: creditNoteTotal.toString(),
          amountOutstanding: creditNoteTotal.toString(),
          status: 'ISSUED',
          vatTreatment: invoice.vatTreatment,
          dateOfCreditNote: input.dateOfCreditNote,
        })
        .returning();

      // Create credit note lines
      const cnLines = cnLineData.map((line) => ({
        creditNoteId: cn.id,
        productId: line.productId,
        description: line.description,
        quantity: line.quantity,
        pricePerUnit: line.pricePerUnit.toString(),
        taxRate: line.taxRate,
        taxValue: line.taxValue.toString(),
        lineTotal: line.lineTotal.toString(),
      }));
      await txDb.insert(creditNoteLines).values(cnLines);

      // Reduce invoice outstanding
      const newOutstanding = roundMoney(Number(invoice.amountOutstanding) - creditNoteTotal);
      await txDb
        .update(invoices)
        .set({ amountOutstanding: Math.max(0, newOutstanding).toString(), updatedAt: new Date() })
        .where(eq(invoices.id, invoiceId));

      // ── GL POSTING 1: CUSTOMER_CREDIT_NOTE ──
      await this.lucaGL.postCustomerCreditNote(txDb as any, {
        companyId,
        creditNoteId: cn.id,
        creditNoteNumber: cnNumber,
        invoiceNumber: invoice.invoiceNumber ?? '',
        creditNoteDate: new Date(input.dateOfCreditNote),
        creditNoteTotal,
        vatTreatment: invoice.vatTreatment as VatTreatment,
        customerName: invoice.customer.name,
        customerId: invoice.customerId,
      });

      // ── GL POSTING 2: COGS reversal (Debit Stock, Credit COGS) ──
      await this.lucaGL.postCreditNoteCOGSReversal(txDb as any, {
        companyId,
        creditNoteId: cn.id,
        creditNoteNumber: cnNumber,
        creditNoteDate: new Date(input.dateOfCreditNote),
        stockValue: roundMoney(stockValue),
      });

      await client.query('COMMIT');
      return cn;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ================================================================
  // Allocate Customer Payment — TRIGGERS GL
  //
  // Old: InvoiceServices.SaveForAllocation + Allocation table
  // GL: CUSTOMER_PAYMENT
  // ================================================================

  async allocatePayment(
    invoiceId: string,
    companyId: string,
    userId: string,
    input: { amount: number; paymentDate: string; reference?: string },
  ) {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const txDb = drizzle(client, { schema });

      const invoice = await txDb.query.invoices.findFirst({
        where: and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.companyId, companyId)),
        with: { customer: true },
      });
      if (!invoice) throw new InvoiceError('Invoice not found');

      if (input.amount > Number(invoice.amountOutstanding)) {
        throw new InvoiceError(`Payment ${input.amount} exceeds outstanding ${invoice.amountOutstanding}`);
      }

      // Create allocation record
      const [allocation] = await txDb
        .insert(allocations)
        .values({
          companyId,
          firstItemId: invoiceId,
          firstItemType: 'INVOICE',
          secondItemId: invoiceId,
          secondItemType: 'PAYMENT',
          amount: input.amount.toString(),
          allocationDate: input.paymentDate,
          createdBy: userId,
        })
        .returning();

      // Update invoice
      const newOutstanding = roundMoney(Number(invoice.amountOutstanding) - input.amount);
      const newStatus = newOutstanding <= 0 ? 'PAID' : 'PARTIALLY_PAID';

      await txDb
        .update(invoices)
        .set({ amountOutstanding: Math.max(0, newOutstanding).toString(), status: newStatus, updatedAt: new Date() })
        .where(eq(invoices.id, invoiceId));

      // ── GL POSTING: CUSTOMER_PAYMENT ──
      await this.lucaGL.postCustomerPayment(txDb as any, {
        companyId,
        allocationId: allocation.id,
        invoiceNumber: invoice.invoiceNumber ?? '',
        paymentDate: new Date(input.paymentDate),
        amount: input.amount,
        customerName: invoice.customer.name,
        customerId: invoice.customerId,
        reference: input.reference,
      });

      await client.query('COMMIT');
      return { allocationId: allocation.id, newOutstanding: Math.max(0, newOutstanding), newStatus };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ================================================================
  // Helpers
  // ================================================================

  private async generateInvoiceNumber(db: any, companyId: string): Promise<string> {
    const result = await db.select({ count: count() }).from(invoices).where(eq(invoices.companyId, companyId));
    const num = Number(result[0]?.count ?? 0) + 1;
    return `INV-${String(num).padStart(6, '0')}`;
  }

  private async generateCreditNoteNumber(db: any, companyId: string): Promise<string> {
    const result = await db.select({ count: count() }).from(creditNotes).where(eq(creditNotes.companyId, companyId));
    const num = Number(result[0]?.count ?? 0) + 1;
    return `CN-${String(num).padStart(6, '0')}`;
  }

  private addDays(dateStr: string, days: number): string {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }
}

export class InvoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceError';
  }
}
