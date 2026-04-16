import { eq, and, isNull, count } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getDb, getPool } from '../../config/database.js';
import {
  supplierInvoices, supplierCreditNotes, purchaseOrderLines,
  suppliers, purchaseOrders, allocations,
} from '../../db/schema/index.js';
import * as schema from '../../db/schema/index.js';
import { LucaGLService } from '../../integrations/luca/luca-gl.service.js';
import { LUCA_ACCOUNTS } from '../../integrations/luca/luca-account-map.js';
import { PurchaseOrderService } from './purchase-order.service.js';
import type { CreateSupplierInvoiceInput, CreateSupplierCreditNoteInput } from './purchase-order.schema.js';
import { roundMoney } from '../../shared/utils/currency.js';
import type { VatTreatment } from '@smmta/shared-types';

/**
 * SupplierInvoiceService — Supplier invoice and credit note management
 * with GL posting to Luca.
 *
 * Source: Libraries/DSB.Service/Suppliers/SupplierInvoiceServices.cs
 *   Insert, InsertBulk, PostInvoice, GetById, Update, Delete
 * GL source: Libraries/DSB.Service/Ledgers/GeneralLedgerServices.cs
 *   LedgerEntryFromStockPurchaseInvoiceLineObject (line 3865)
 *   LedgerEntryFromNonStockPurchaseInvoiceLineObject (line 3603)
 */
export class SupplierInvoiceService {
  private db = getDb();
  private lucaGL = new LucaGLService();
  private poService = new PurchaseOrderService();

  // ── List supplier invoices ──

  async list(companyId: string, query: {
    page: number; pageSize: number;
    supplierId?: string; purchaseOrderId?: string; status?: string;
  }) {
    const { page, pageSize, supplierId, purchaseOrderId, status } = query;
    const offset = (page - 1) * pageSize;

    const conditions = [eq(supplierInvoices.companyId, companyId), isNull(supplierInvoices.deletedAt)];
    if (supplierId) conditions.push(eq(supplierInvoices.supplierId, supplierId));
    if (purchaseOrderId) conditions.push(eq(supplierInvoices.purchaseOrderId, purchaseOrderId));
    if (status) conditions.push(eq(supplierInvoices.status, status as any));

    const where = and(...conditions);

    const [totalResult, rows] = await Promise.all([
      this.db.select({ count: count() }).from(supplierInvoices).where(where),
      this.db.query.supplierInvoices.findMany({
        where,
        with: { supplier: true, purchaseOrder: true },
        limit: pageSize,
        offset,
        orderBy: (si, { desc }) => [desc(si.createdAt)],
      }),
    ]);

    return {
      data: rows,
      total: Number(totalResult[0]?.count ?? 0),
      page,
      pageSize,
      totalPages: Math.ceil(Number(totalResult[0]?.count ?? 0) / pageSize),
    };
  }

  // ── Get by ID ──

  async getById(id: string, companyId: string) {
    return this.db.query.supplierInvoices.findFirst({
      where: and(eq(supplierInvoices.id, id), eq(supplierInvoices.companyId, companyId), isNull(supplierInvoices.deletedAt)),
      with: {
        supplier: true,
        purchaseOrder: { with: { lines: { with: { product: true } } } },
        creditNotes: { where: isNull(supplierCreditNotes.deletedAt) },
      },
    });
  }

  // ── Create Supplier Invoice from PO — triggers GL ──

  async createFromPO(
    purchaseOrderId: string,
    companyId: string,
    userId: string,
    input: CreateSupplierInvoiceInput,
  ) {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const txDb = drizzle(client, { schema });

      // Load PO with supplier
      const po = await txDb.query.purchaseOrders.findFirst({
        where: and(eq(schema.purchaseOrders.id, purchaseOrderId), eq(schema.purchaseOrders.companyId, companyId)),
        with: { supplier: true, lines: { where: isNull(schema.purchaseOrderLines.deletedAt) } },
      });
      if (!po) throw new SupplierInvoiceError('Purchase order not found');

      // Calculate totals from PO lines (or provided lines)
      let lineTotal = 0;
      let taxTotal = 0;

      if (input.lines && input.lines.length > 0) {
        for (const line of input.lines) {
          const lt = roundMoney(line.quantity * line.pricePerUnit);
          const tax = roundMoney(lt * (line.taxRate / 100));
          lineTotal += lt;
          taxTotal += tax;
        }
      } else {
        // Use PO line totals
        for (const line of po.lines) {
          lineTotal += Number(line.lineTotal ?? 0);
          taxTotal += Number(line.taxValue ?? 0);
        }
      }

      const grandTotal = roundMoney(lineTotal + taxTotal + input.deliveryCharge);

      // Create supplier invoice
      const [invoice] = await txDb
        .insert(supplierInvoices)
        .values({
          companyId,
          purchaseOrderId,
          supplierId: po.supplierId,
          contactId: po.contactId,
          addressId: po.addressId,
          currencyCode: po.currencyCode,
          invoiceNumber: input.invoiceNumber,
          deliveryCharge: input.deliveryCharge.toString(),
          lineTotal: lineTotal.toString(),
          taxTotal: taxTotal.toString(),
          grandTotal: grandTotal.toString(),
          amountOutstanding: grandTotal.toString(),
          status: 'APPROVED',
          vatTreatment: po.vatTreatment,
          dateOfInvoice: input.dateOfInvoice,
          dueDateOfInvoice: input.dueDateOfInvoice,
        })
        .returning();

      // Update PO line invoiced quantities
      for (const poLine of po.lines) {
        const newQtyInvoiced = poLine.quantity; // Full invoice
        await txDb
          .update(purchaseOrderLines)
          .set({ qtyInvoiced: newQtyInvoiced, updatedAt: new Date() })
          .where(eq(purchaseOrderLines.id, poLine.id));
      }

      // ── GL POSTING: SUPPLIER_INVOICE ──
      // For stock purchases: account_code = 2310 (GRNI Accrual — clears the GRN entry)
      // For non-stock: use the provided account code or supplier default
      const accountCode = input.isStockPurchase
        ? LUCA_ACCOUNTS.GRNI_ACCRUAL
        : (input.accountCode ?? po.supplier.defaultExpenseAccountCode ?? LUCA_ACCOUNTS.COGS);

      await this.lucaGL.postSupplierInvoice(txDb as any, {
        companyId,
        supplierInvoiceId: invoice.id,
        invoiceNumber: input.invoiceNumber,
        supplierName: po.supplier.name,
        supplierId: po.supplierId,
        invoiceDate: new Date(input.dateOfInvoice),
        grossTotal: grandTotal,
        accountCode,
        vatTreatment: po.vatTreatment as VatTreatment,
      });

      await client.query('COMMIT');

      // Recalculate PO invoiced status
      await this.poService.recalculateInvoicedStatus(purchaseOrderId);

      return this.getById(invoice.id, companyId);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Create Supplier Credit Note — triggers GL ──

  async createCreditNote(
    supplierInvoiceId: string,
    companyId: string,
    userId: string,
    input: CreateSupplierCreditNoteInput,
  ) {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const txDb = drizzle(client, { schema });

      // Load supplier invoice with supplier
      const invoice = await txDb.query.supplierInvoices.findFirst({
        where: and(eq(schema.supplierInvoices.id, supplierInvoiceId), eq(schema.supplierInvoices.companyId, companyId)),
        with: { supplier: true },
      });
      if (!invoice) throw new SupplierInvoiceError('Supplier invoice not found');

      // Create credit note
      const [cn] = await txDb
        .insert(supplierCreditNotes)
        .values({
          companyId,
          supplierInvoiceId,
          supplierId: invoice.supplierId,
          contactId: invoice.contactId,
          addressId: invoice.addressId,
          currencyCode: invoice.currencyCode,
          creditNoteNumber: input.creditNoteNumber,
          creditNoteTotal: input.creditNoteTotal.toString(),
          amountOutstanding: input.creditNoteTotal.toString(),
          status: 'ISSUED',
          vatTreatment: invoice.vatTreatment,
          dateOfCreditNote: input.dateOfCreditNote,
        })
        .returning();

      // Reduce invoice outstanding amount
      const newOutstanding = roundMoney(Number(invoice.amountOutstanding) - input.creditNoteTotal);
      await txDb
        .update(supplierInvoices)
        .set({ amountOutstanding: Math.max(0, newOutstanding).toString(), updatedAt: new Date() })
        .where(eq(supplierInvoices.id, supplierInvoiceId));

      // ── GL POSTING: SUPPLIER_CREDIT_NOTE ──
      const accountCode = input.accountCode ?? LUCA_ACCOUNTS.GRNI_ACCRUAL;

      await this.lucaGL.postSupplierCreditNote(txDb as any, {
        companyId,
        creditNoteId: cn.id,
        creditNoteNumber: input.creditNoteNumber,
        supplierName: invoice.supplier.name,
        supplierId: invoice.supplierId,
        creditNoteDate: new Date(input.dateOfCreditNote),
        creditNoteTotal: input.creditNoteTotal,
        accountCode,
        vatTreatment: invoice.vatTreatment as VatTreatment,
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

  // ── Allocate Supplier Payment — triggers GL ──

  async allocatePayment(
    supplierInvoiceId: string,
    companyId: string,
    userId: string,
    input: { amount: number; paymentDate: string; reference?: string },
  ) {
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const txDb = drizzle(client, { schema });

      const invoice = await txDb.query.supplierInvoices.findFirst({
        where: and(eq(schema.supplierInvoices.id, supplierInvoiceId), eq(schema.supplierInvoices.companyId, companyId)),
        with: { supplier: true },
      });
      if (!invoice) throw new SupplierInvoiceError('Supplier invoice not found');

      if (input.amount > Number(invoice.amountOutstanding)) {
        throw new SupplierInvoiceError(
          `Payment amount ${input.amount} exceeds outstanding ${invoice.amountOutstanding}`,
        );
      }

      // Create allocation record
      const [allocation] = await txDb
        .insert(allocations)
        .values({
          companyId,
          firstItemId: supplierInvoiceId,
          firstItemType: 'SUPPLIER_INVOICE',
          secondItemId: supplierInvoiceId, // Payment reference
          secondItemType: 'SUPPLIER_PAYMENT',
          amount: input.amount.toString(),
          allocationDate: input.paymentDate,
          createdBy: userId,
        })
        .returning();

      // Update invoice outstanding
      const newOutstanding = roundMoney(Number(invoice.amountOutstanding) - input.amount);
      const newStatus = newOutstanding <= 0 ? 'PAID' : 'PARTIALLY_PAID';

      await txDb
        .update(supplierInvoices)
        .set({
          amountOutstanding: Math.max(0, newOutstanding).toString(),
          status: newStatus,
          updatedAt: new Date(),
        })
        .where(eq(supplierInvoices.id, supplierInvoiceId));

      // ── GL POSTING: SUPPLIER_PAYMENT ──
      await this.lucaGL.postSupplierPayment(txDb as any, {
        companyId,
        allocationId: allocation.id,
        invoiceNumber: invoice.invoiceNumber ?? '',
        paymentDate: new Date(input.paymentDate),
        amount: input.amount,
        supplierName: invoice.supplier.name,
        supplierId: invoice.supplierId,
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
}

export class SupplierInvoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplierInvoiceError';
  }
}
