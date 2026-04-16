import { eq } from 'drizzle-orm';
import { LucaClient, LucaApiError } from './luca-client.js';
import { LUCA_ACCOUNTS } from './luca-account-map.js';
import { vatTreatmentToLucaTaxCode } from './luca-tax-map.js';
import { glIdempotencyKey, derivePeriodId } from '../../shared/utils/idempotency.js';
import { toDecimalString } from '../../shared/utils/currency.js';
import { glPostingLog } from '../../db/schema/gl-posting-log.js';
import type { LucaPostTransactionRequest, LucaJournalLine } from './luca-types.js';
import type { VatTreatment } from '@smmta/shared-types';

interface DbTx {
  insert: (table: any) => any;
  update: (table: any) => any;
}

/**
 * LucaGLService — the single point of contact for all GL postings.
 *
 * Every financial event in the app (invoice, credit note, GRN, payment,
 * stock adjustment) is routed through this service. It:
 *   1. Builds the Luca API payload
 *   2. Sends it with an idempotency key
 *   3. Logs the result in gl_posting_log
 *
 * Mapping source: Libraries/DSB.Service/Ledgers/GeneralLedgerServices.cs
 */
export class LucaGLService {
  private client: LucaClient;

  constructor(client?: LucaClient) {
    this.client = client ?? new LucaClient();
  }

  // ================================================================
  // A. Customer Invoice — CUSTOMER_INVOICE + COGS journal
  // Old: InvoiceServices.CustomerInvoiceGLEntryUpdated
  // ================================================================

  async postCustomerInvoice(
    db: DbTx,
    params: {
      companyId: string;
      invoiceId: string;
      invoiceNumber: string;
      orderNumber: string;
      invoiceDate: Date;
      grandTotal: number;
      vatTreatment: VatTreatment;
      customerName: string;
      customerId: string;
    },
  ): Promise<string> {
    const periodId = derivePeriodId(params.invoiceDate);
    const dateStr = params.invoiceDate.toISOString().slice(0, 10);

    const req: LucaPostTransactionRequest = {
      transaction_type: 'CUSTOMER_INVOICE',
      date: dateStr,
      period_id: periodId,
      description: `Invoice ${params.invoiceNumber} for order ${params.orderNumber}`,
      reference: params.invoiceNumber,
      amount: params.grandTotal,
      tax_code: vatTreatmentToLucaTaxCode(params.vatTreatment),
      counterparty: { name: params.customerName, id: params.customerId },
      idempotency_key: glIdempotencyKey('CINV', params.invoiceId),
      submitted_by: 'smmta-next',
    };

    return this.post(db, {
      companyId: params.companyId,
      entityType: 'INVOICE',
      entityId: params.invoiceId,
      request: req,
    });
  }

  /**
   * Posts the COGS / Stock journal that accompanies a customer invoice.
   * Debit COGS (5000), Credit Stock (1150).
   */
  async postInvoiceCOGS(
    db: DbTx,
    params: {
      companyId: string;
      invoiceId: string;
      invoiceNumber: string;
      invoiceDate: Date;
      cogsTotal: number;
    },
  ): Promise<string> {
    if (params.cogsTotal <= 0) return ''; // No COGS to post

    const periodId = derivePeriodId(params.invoiceDate);
    const dateStr = params.invoiceDate.toISOString().slice(0, 10);

    const req: LucaPostTransactionRequest = {
      transaction_type: 'MANUAL_JOURNAL',
      date: dateStr,
      period_id: periodId,
      description: `COGS for Invoice ${params.invoiceNumber}`,
      reference: `COGS-${params.invoiceNumber}`,
      lines: [
        { account_code: LUCA_ACCOUNTS.COGS, amount: toDecimalString(params.cogsTotal), type: 'DEBIT' },
        { account_code: LUCA_ACCOUNTS.STOCK, amount: toDecimalString(params.cogsTotal), type: 'CREDIT' },
      ],
      idempotency_key: glIdempotencyKey('COGS', params.invoiceId),
      submitted_by: 'smmta-next',
    };

    return this.post(db, {
      companyId: params.companyId,
      entityType: 'INVOICE_COGS',
      entityId: params.invoiceId,
      request: req,
    });
  }

  // ================================================================
  // B. Customer Credit Note — CUSTOMER_CREDIT_NOTE + COGS reversal
  // ================================================================

  async postCustomerCreditNote(
    db: DbTx,
    params: {
      companyId: string;
      creditNoteId: string;
      creditNoteNumber: string;
      invoiceNumber: string;
      creditNoteDate: Date;
      creditNoteTotal: number;
      vatTreatment: VatTreatment;
      customerName: string;
      customerId: string;
    },
  ): Promise<string> {
    const periodId = derivePeriodId(params.creditNoteDate);
    const dateStr = params.creditNoteDate.toISOString().slice(0, 10);

    const req: LucaPostTransactionRequest = {
      transaction_type: 'CUSTOMER_CREDIT_NOTE',
      date: dateStr,
      period_id: periodId,
      description: `Credit Note ${params.creditNoteNumber} against Invoice ${params.invoiceNumber}`,
      reference: params.creditNoteNumber,
      amount: params.creditNoteTotal,
      tax_code: vatTreatmentToLucaTaxCode(params.vatTreatment),
      counterparty: { name: params.customerName, id: params.customerId },
      idempotency_key: glIdempotencyKey('CCN', params.creditNoteId),
      submitted_by: 'smmta-next',
    };

    return this.post(db, {
      companyId: params.companyId,
      entityType: 'CREDIT_NOTE',
      entityId: params.creditNoteId,
      request: req,
    });
  }

  async postCreditNoteCOGSReversal(
    db: DbTx,
    params: {
      companyId: string;
      creditNoteId: string;
      creditNoteNumber: string;
      creditNoteDate: Date;
      stockValue: number;
    },
  ): Promise<string> {
    if (params.stockValue <= 0) return '';

    const periodId = derivePeriodId(params.creditNoteDate);
    const dateStr = params.creditNoteDate.toISOString().slice(0, 10);

    const req: LucaPostTransactionRequest = {
      transaction_type: 'MANUAL_JOURNAL',
      date: dateStr,
      period_id: periodId,
      description: `COGS reversal for Credit Note ${params.creditNoteNumber}`,
      reference: `COGS-REV-${params.creditNoteNumber}`,
      lines: [
        { account_code: LUCA_ACCOUNTS.STOCK, amount: toDecimalString(params.stockValue), type: 'DEBIT' },
        { account_code: LUCA_ACCOUNTS.COGS, amount: toDecimalString(params.stockValue), type: 'CREDIT' },
      ],
      idempotency_key: glIdempotencyKey('COGS-REV', params.creditNoteId),
      submitted_by: 'smmta-next',
    };

    return this.post(db, {
      companyId: params.companyId,
      entityType: 'CREDIT_NOTE_COGS_REV',
      entityId: params.creditNoteId,
      request: req,
    });
  }

  // ================================================================
  // C. Goods Received Note (Book-In Stock)
  // Old: GeneralLedgerServices.LedgerEntryFromBookInStockLineObject
  // ================================================================

  async postGoodsReceivedNote(
    db: DbTx,
    params: {
      companyId: string;
      grnId: string;
      grnNumber: string;
      poNumber: string;
      bookedInDate: Date;
      stockValue: number;
      deliveryCharge: number;
      isService: boolean;
    },
  ): Promise<string> {
    const periodId = derivePeriodId(params.bookedInDate);
    const dateStr = params.bookedInDate.toISOString().slice(0, 10);
    const totalDebit = params.stockValue + params.deliveryCharge;

    const lines: LucaJournalLine[] = [
      { account_code: LUCA_ACCOUNTS.STOCK, amount: toDecimalString(totalDebit), type: 'DEBIT' },
      {
        account_code: params.isService
          ? LUCA_ACCOUNTS.SERVICE_GRNI_ACCRUAL
          : LUCA_ACCOUNTS.GRNI_ACCRUAL,
        amount: toDecimalString(params.stockValue),
        type: 'CREDIT',
      },
    ];

    if (params.deliveryCharge > 0) {
      lines.push({
        account_code: LUCA_ACCOUNTS.DELIVERY_GRNI_ACCRUAL,
        amount: toDecimalString(params.deliveryCharge),
        type: 'CREDIT',
      });
    }

    const req: LucaPostTransactionRequest = {
      transaction_type: 'MANUAL_JOURNAL',
      date: dateStr,
      period_id: periodId,
      description: `GRN ${params.grnNumber} — Book-in for PO ${params.poNumber}`,
      reference: `GRN-${params.grnNumber}`,
      lines,
      idempotency_key: glIdempotencyKey('GRN', params.grnId),
      submitted_by: 'smmta-next',
    };

    return this.post(db, {
      companyId: params.companyId,
      entityType: 'GRN',
      entityId: params.grnId,
      request: req,
    });
  }

  // ================================================================
  // D. Supplier Invoice — SUPPLIER_INVOICE
  // Old: GeneralLedgerServices.LedgerEntryFromStockPurchaseInvoiceLineObject
  // ================================================================

  async postSupplierInvoice(
    db: DbTx,
    params: {
      companyId: string;
      supplierInvoiceId: string;
      invoiceNumber: string;
      supplierName: string;
      supplierId: string;
      invoiceDate: Date;
      grossTotal: number;
      accountCode: string; // '2310' for stock POs, or expense code for non-stock
      vatTreatment: VatTreatment;
    },
  ): Promise<string> {
    const periodId = derivePeriodId(params.invoiceDate);
    const dateStr = params.invoiceDate.toISOString().slice(0, 10);

    const req: LucaPostTransactionRequest = {
      transaction_type: 'SUPPLIER_INVOICE',
      date: dateStr,
      period_id: periodId,
      description: `Supplier Invoice ${params.invoiceNumber} from ${params.supplierName}`,
      reference: params.invoiceNumber,
      amount: params.grossTotal,
      account_code: params.accountCode,
      tax_code: vatTreatmentToLucaTaxCode(params.vatTreatment),
      counterparty: { name: params.supplierName, id: params.supplierId },
      idempotency_key: glIdempotencyKey('SINV', params.supplierInvoiceId),
      submitted_by: 'smmta-next',
    };

    return this.post(db, {
      companyId: params.companyId,
      entityType: 'SUPPLIER_INVOICE',
      entityId: params.supplierInvoiceId,
      request: req,
    });
  }

  // ================================================================
  // E. Supplier Credit Note — SUPPLIER_CREDIT_NOTE
  // ================================================================

  async postSupplierCreditNote(
    db: DbTx,
    params: {
      companyId: string;
      creditNoteId: string;
      creditNoteNumber: string;
      supplierName: string;
      supplierId: string;
      creditNoteDate: Date;
      creditNoteTotal: number;
      accountCode: string;
      vatTreatment: VatTreatment;
    },
  ): Promise<string> {
    const periodId = derivePeriodId(params.creditNoteDate);
    const dateStr = params.creditNoteDate.toISOString().slice(0, 10);

    const req: LucaPostTransactionRequest = {
      transaction_type: 'SUPPLIER_CREDIT_NOTE',
      date: dateStr,
      period_id: periodId,
      description: `Supplier CN ${params.creditNoteNumber} from ${params.supplierName}`,
      reference: params.creditNoteNumber,
      amount: params.creditNoteTotal,
      account_code: params.accountCode,
      tax_code: vatTreatmentToLucaTaxCode(params.vatTreatment),
      counterparty: { name: params.supplierName, id: params.supplierId },
      idempotency_key: glIdempotencyKey('SCN', params.creditNoteId),
      submitted_by: 'smmta-next',
    };

    return this.post(db, {
      companyId: params.companyId,
      entityType: 'SUPPLIER_CREDIT_NOTE',
      entityId: params.creditNoteId,
      request: req,
    });
  }

  // ================================================================
  // F. Customer Payment — CUSTOMER_PAYMENT
  // ================================================================

  async postCustomerPayment(
    db: DbTx,
    params: {
      companyId: string;
      allocationId: string;
      invoiceNumber: string;
      paymentDate: Date;
      amount: number;
      customerName: string;
      customerId: string;
      reference?: string;
    },
  ): Promise<string> {
    const periodId = derivePeriodId(params.paymentDate);
    const dateStr = params.paymentDate.toISOString().slice(0, 10);

    const req: LucaPostTransactionRequest = {
      transaction_type: 'CUSTOMER_PAYMENT',
      date: dateStr,
      period_id: periodId,
      description: `Payment from ${params.customerName} against Invoice ${params.invoiceNumber}`,
      reference: params.reference ?? params.invoiceNumber,
      amount: params.amount,
      counterparty: { name: params.customerName, id: params.customerId },
      idempotency_key: glIdempotencyKey('CPAY', params.allocationId),
      submitted_by: 'smmta-next',
    };

    return this.post(db, {
      companyId: params.companyId,
      entityType: 'CUSTOMER_PAYMENT',
      entityId: params.allocationId,
      request: req,
    });
  }

  // ================================================================
  // G. Supplier Payment — SUPPLIER_PAYMENT
  // ================================================================

  async postSupplierPayment(
    db: DbTx,
    params: {
      companyId: string;
      allocationId: string;
      invoiceNumber: string;
      paymentDate: Date;
      amount: number;
      supplierName: string;
      supplierId: string;
      reference?: string;
    },
  ): Promise<string> {
    const periodId = derivePeriodId(params.paymentDate);
    const dateStr = params.paymentDate.toISOString().slice(0, 10);

    const req: LucaPostTransactionRequest = {
      transaction_type: 'SUPPLIER_PAYMENT',
      date: dateStr,
      period_id: periodId,
      description: `Payment to ${params.supplierName} against Invoice ${params.invoiceNumber}`,
      reference: params.reference ?? params.invoiceNumber,
      amount: params.amount,
      counterparty: { name: params.supplierName, id: params.supplierId },
      idempotency_key: glIdempotencyKey('SPAY', params.allocationId),
      submitted_by: 'smmta-next',
    };

    return this.post(db, {
      companyId: params.companyId,
      entityType: 'SUPPLIER_PAYMENT',
      entityId: params.allocationId,
      request: req,
    });
  }

  // ================================================================
  // H. Stock Adjustment — MANUAL_JOURNAL
  // Old: GeneralLedgerServices.LedgerEntryFromStockAdjustmentObject
  // ================================================================

  async postStockAdjustment(
    db: DbTx,
    params: {
      companyId: string;
      adjustmentId: string;
      adjustmentDate: Date;
      stockValue: number;
      type: 'ADD' | 'REMOVE';
      productName: string;
    },
  ): Promise<string> {
    if (params.stockValue <= 0) return '';

    const periodId = derivePeriodId(params.adjustmentDate);
    const dateStr = params.adjustmentDate.toISOString().slice(0, 10);

    const isAdd = params.type === 'ADD';
    const lines: LucaJournalLine[] = isAdd
      ? [
          { account_code: LUCA_ACCOUNTS.STOCK, amount: toDecimalString(params.stockValue), type: 'DEBIT' },
          { account_code: LUCA_ACCOUNTS.STOCK_WRITE_BACK, amount: toDecimalString(params.stockValue), type: 'CREDIT' },
        ]
      : [
          { account_code: LUCA_ACCOUNTS.STOCK_WRITE_OFFS, amount: toDecimalString(params.stockValue), type: 'DEBIT' },
          { account_code: LUCA_ACCOUNTS.STOCK, amount: toDecimalString(params.stockValue), type: 'CREDIT' },
        ];

    const req: LucaPostTransactionRequest = {
      transaction_type: 'MANUAL_JOURNAL',
      date: dateStr,
      period_id: periodId,
      description: `Stock adjustment — ${params.type} ${params.productName}`,
      reference: `SADJ-${params.type}-${params.adjustmentId}`,
      lines,
      idempotency_key: glIdempotencyKey('SADJ', params.adjustmentId),
      submitted_by: 'smmta-next',
    };

    return this.post(db, {
      companyId: params.companyId,
      entityType: 'STOCK_ADJUSTMENT',
      entityId: params.adjustmentId,
      request: req,
    });
  }

  // ================================================================
  // Private: Send to Luca and log
  // ================================================================

  private async post(
    db: DbTx,
    opts: {
      companyId: string;
      entityType: string;
      entityId: string;
      request: LucaPostTransactionRequest;
    },
  ): Promise<string> {
    // Write PENDING log entry
    const [logEntry] = await db
      .insert(glPostingLog)
      .values({
        companyId: opts.companyId,
        entityType: opts.entityType,
        entityId: opts.entityId,
        lucaTransactionType: opts.request.transaction_type,
        idempotencyKey: opts.request.idempotency_key!,
        amount: opts.request.amount?.toString(),
        description: opts.request.description,
        status: 'PENDING',
        requestPayload: opts.request as any,
      })
      .returning();

    try {
      const response = await this.client.postTransaction(opts.request);

      // Update log to SUCCESS
      await db
        .update(glPostingLog)
        .set({
          status: 'SUCCESS',
          lucaTransactionId: response.transaction_id,
          responsePayload: response as any,
          updatedAt: new Date(),
        })
        .where(eq(glPostingLog.id, logEntry.id));

      return response.transaction_id;
    } catch (err) {
      const errorMsg = err instanceof LucaApiError
        ? err.message
        : (err as Error).message;

      // Update log to FAILED
      await db
        .update(glPostingLog)
        .set({
          status: 'FAILED',
          errorMessage: errorMsg,
          responsePayload: err instanceof LucaApiError ? (err.responseBody as any) : null,
          updatedAt: new Date(),
        })
        .where(eq(glPostingLog.id, logEntry.id));

      throw err; // Re-throw so the calling service can roll back
    }
  }
}
