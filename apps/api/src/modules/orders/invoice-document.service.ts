/**
 * Invoice PDFs, stored with the invoice.
 *
 * The PDF is rendered from the invoice record the first time it is needed —
 * straight after shipping, or when first opened — and the file is kept. A
 * stored invoice is never re-rendered: an issued invoice must not change after
 * the customer may have seen it.
 *
 * Files sit in LABELS_DIR/invoices on the private volume, with the bare
 * server-generated filename in invoices.pdf_url, and leave the server only
 * through the authenticated invoice route.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getEnv } from '../../config/env.js';
import {
  customerDeliveryAddresses,
  customerInvoiceAddresses,
  invoiceLines,
  invoices,
} from '../../db/schema/index.js';
import { toPence } from './invoice-figures.js';
import { longDate, renderInvoicePdf, type InvoicePdfInput } from './invoice-pdf.js';

/** Filenames are always a server-generated UUID; anything else is refused. */
const FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;

type Address = {
  contactName: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postCode: string | null;
  country: string | null;
};

const addressLines = (a: Address | undefined): string[] =>
  a
    ? [a.contactName, a.line1, a.line2, a.city, a.region, a.postCode, a.country]
        .map((v) => (v ?? '').trim())
        .filter(Boolean)
    : [];

export class InvoiceDocumentService {
  private readonly db = getDb();

  constructor(private readonly deps: { dir?: string } = {}) {}

  private get dir(): string {
    return resolve(this.deps.dir ?? join(getEnv().LABELS_DIR, 'invoices'));
  }

  /** The invoice PDF, rendered and stored the first time it is asked for. */
  async readPdf(invoiceId: string, companyId: string): Promise<{ buffer: Buffer; filename: string } | null> {
    const invoice = await this.load(invoiceId, companyId);
    if (!invoice) return null;
    const filename = `invoice-${invoice.invoiceNumber ?? invoice.id}.pdf`;

    const stored = invoice.pdfUrl ? basename(invoice.pdfUrl) : null;
    if (stored && FILENAME.test(stored)) {
      try {
        return { buffer: await readFile(join(this.dir, stored)), filename };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }

    const buffer = await renderInvoicePdf(await this.documentFor(invoice));
    const name = `${randomUUID()}.pdf`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, name), buffer);
    await this.db.update(invoices).set({ pdfUrl: name, updatedAt: new Date() }).where(eq(invoices.id, invoice.id));
    return { buffer, filename };
  }

  /** Makes sure the PDF has been made and stored, e.g. straight after shipping. */
  async ensurePdf(invoiceId: string, companyId: string): Promise<void> {
    await this.readPdf(invoiceId, companyId);
  }

  private load(invoiceId: string, companyId: string) {
    return this.db.query.invoices.findFirst({
      where: and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId), isNull(invoices.deletedAt)),
      with: {
        customer: true,
        order: true,
        lines: { where: isNull(invoiceLines.deletedAt), with: { product: true } },
      },
    });
  }

  private async documentFor(
    invoice: NonNullable<Awaited<ReturnType<InvoiceDocumentService['load']>>>,
  ): Promise<InvoicePdfInput> {
    const [invoiceAddress] = invoice.invoiceAddressId
      ? await this.db.select().from(customerInvoiceAddresses).where(eq(customerInvoiceAddresses.id, invoice.invoiceAddressId)).limit(1)
      : [];
    const [deliveryAddress] = invoice.deliveryAddressId
      ? await this.db.select().from(customerDeliveryAddresses).where(eq(customerDeliveryAddresses.id, invoice.deliveryAddressId)).limit(1)
      : [];

    const customerName = invoice.customer?.name?.trim() ?? '';
    const withCustomer = (lines: string[], contactName: string | null | undefined) =>
      contactName?.trim() ? lines : [customerName, ...lines].filter(Boolean);
    const billTo = invoiceAddress
      ? withCustomer(addressLines(invoiceAddress), invoiceAddress.contactName)
      : deliveryAddress
        ? withCustomer(addressLines(deliveryAddress), deliveryAddress.contactName)
        : [customerName];

    // Invoice lines hold net amounts; any VAT beyond theirs is the delivery's.
    const linesVat = invoice.lines.reduce((sum, l) => sum + toPence(l.taxValue), 0);
    const deliveryNet = toPence(invoice.deliveryCharge);
    const deliveryVat = Math.max(0, toPence(invoice.taxTotal) - linesVat);
    const standardRate = invoice.lines.find((l) => Number(l.taxRate) > 0)?.taxRate ?? 20;

    const mollie = (invoice.order?.integrationMetadata as { mollie?: { status?: string } } | null)?.mollie;
    const paidOnline = mollie?.status === 'paid';
    const paymentNote = paidOnline
      ? `Paid online on ${longDate(String(invoice.order?.orderDate ?? invoice.dateOfInvoice))}. Thank you for your order.`
      : invoice.dueDateOfInvoice
        ? `Payment due by ${longDate(String(invoice.dueDateOfInvoice))}. Please quote invoice ${invoice.invoiceNumber ?? ''} with your payment.`
        : 'Thank you for your order.';

    return {
      invoiceNumber: invoice.invoiceNumber ?? invoice.id.slice(0, 8).toUpperCase(),
      invoiceDate: String(invoice.dateOfInvoice),
      dueDate: paidOnline || !invoice.dueDateOfInvoice ? null : String(invoice.dueDateOfInvoice),
      orderNumber: invoice.order?.orderNumber ?? '',
      customerReference: invoice.order?.customerOrderNumber ?? null,
      billTo,
      deliverTo: deliveryAddress ? addressLines(deliveryAddress) : null,
      lines: invoice.lines.map((l) => ({
        description: l.product?.name ?? 'Item',
        sku: l.product?.stockCode ?? null,
        quantity: Number(l.quantity),
        unitNetPence: toPence(l.pricePerUnit),
        vatRate: Number(l.taxRate ?? 0),
        netPence: toPence(l.lineTotal),
      })),
      delivery: deliveryNet > 0 || deliveryVat > 0 ? { netPence: deliveryNet, vatRate: deliveryVat > 0 ? Number(standardRate) : 0 } : null,
      totals: {
        netPence: toPence(invoice.lineTotal) + deliveryNet,
        vatPence: toPence(invoice.taxTotal),
        grossPence: toPence(invoice.grandTotal),
      },
      paymentNote,
    };
  }
}
