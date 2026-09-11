/**
 * Renders an invoice as an A4 PDF.
 *
 * Carries what a UK VAT invoice has to show: the supplier's name, address and
 * VAT number; an invoice number and date (the tax point); the customer's name
 * and address; each item's quantity, unit price excluding VAT, VAT rate and net
 * amount; and the net, VAT and gross totals.
 *
 * Standard PDF fonts only; text is passed through pdfText so nothing prints as
 * garbage.
 */
import PDFDocument from 'pdfkit';
import { SELLER } from '../../config/seller.js';
import { pdfText } from '../shipping/pick-note-content.js';

export interface InvoicePdfLine {
  description: string;
  sku: string | null;
  quantity: number;
  unitNetPence: number;
  vatRate: number;
  netPence: number;
}

export interface InvoicePdfInput {
  invoiceNumber: string;
  /** YYYY-MM-DD, the tax point. */
  invoiceDate: string;
  dueDate: string | null;
  orderNumber: string;
  customerReference: string | null;
  billTo: string[];
  deliverTo: string[] | null;
  lines: InvoicePdfLine[];
  delivery: { netPence: number; vatRate: number } | null;
  totals: { netPence: number; vatPence: number; grossPence: number };
  paymentNote: string;
}

/** A4, in PDF points. */
export const A4: [number, number] = [595.28, 841.89];

const MARGIN = 48;
const WIDTH = A4[0] - MARGIN * 2;
const BODY_BOTTOM = A4[1] - MARGIN - 36;

const DESC_W = 238;
const QTY_X = MARGIN + 246;
const QTY_W = 40;
const UNIT_X = MARGIN + 292;
const UNIT_W = 84;
const VAT_X = MARGIN + 382;
const VAT_W = 40;
const NET_X = MARGIN + 428;
const NET_W = WIDTH - 428;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 2026-09-11 → 11 September 2026, without going through a timezone. */
export function longDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return isoDate;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

export function gbp(pence: number): string {
  return `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const rate = (r: number) => `${Number.isInteger(r) ? r : Math.round(r * 100) / 100}%`;
const qty = (q: number) => (Number.isInteger(q) ? String(q) : String(Math.round(q * 1000) / 1000));

export async function renderInvoicePdf(inv: InvoicePdfInput, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const doc = new PDFDocument({
    size: A4,
    margin: MARGIN,
    bufferPages: true,
    compress: opts.compress ?? true,
    info: { Title: `Invoice ${inv.invoiceNumber}`, Author: SELLER.legalName, Creator: 'SMMTA-Next' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const half = WIDTH / 2;

  // ---- Supplier (left) ----
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(18).text(pdfText(SELLER.brand), MARGIN, MARGIN, { width: half });
  doc.font('Helvetica').fontSize(8.5).fillColor('#444');
  doc.text(pdfText(`${SELLER.brand} is a ${SELLER.tradingAs} brand. ${SELLER.tradingAs} is a trading name of ${SELLER.legalName}.`), MARGIN, doc.y + 2, { width: half - 10 });
  doc.text(SELLER.addressLines.map(pdfText).join('\n'), MARGIN, doc.y + 4, { width: half - 10 });
  doc.text(pdfText(SELLER.email), MARGIN, doc.y + 4, { width: half - 10 });
  doc.text(pdfText(`VAT registration number ${SELLER.vatNumber}`), MARGIN, doc.y, { width: half - 10 });
  const supplierBottom = doc.y;

  // ---- Invoice details (right) ----
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(20).text('VAT INVOICE', MARGIN + half, MARGIN, { width: half, align: 'right' });
  const details: Array<[string, string]> = [
    ['Invoice number', inv.invoiceNumber],
    ['Invoice date', longDate(inv.invoiceDate)],
    ['Order number', inv.orderNumber],
  ];
  if (inv.customerReference) details.push(['Your reference', inv.customerReference]);
  let dy = MARGIN + 32;
  for (const [label, value] of details) {
    doc.font('Helvetica').fontSize(9).fillColor('#444').text(label, MARGIN + half, dy, { width: half / 2 });
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text(pdfText(value), MARGIN + half + half / 2, dy, { width: half / 2, align: 'right' });
    dy += 14;
  }

  // ---- Addresses ----
  let y = Math.max(supplierBottom, dy) + 22;
  const addressBlock = (title: string, lines: string[], x: number): number => {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#444').text(title, x, y, { width: half - 12 });
    doc.font('Helvetica').fontSize(10).fillColor('#000').text(lines.map(pdfText).filter(Boolean).join('\n') || '-', x, y + 13, { width: half - 12 });
    return doc.y;
  };
  const billBottom = addressBlock('INVOICE TO', inv.billTo, MARGIN);
  const deliverBottom = inv.deliverTo ? addressBlock('DELIVER TO', inv.deliverTo, MARGIN + half) : y;
  y = Math.max(billBottom, deliverBottom) + 24;

  // ---- Items ----
  const tableHeader = (top: number): number => {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#444');
    doc.text('DESCRIPTION', MARGIN, top, { width: DESC_W });
    doc.text('QTY', QTY_X, top, { width: QTY_W, align: 'right' });
    doc.text('UNIT PRICE EX VAT', UNIT_X, top, { width: UNIT_W, align: 'right' });
    doc.text('VAT', VAT_X, top, { width: VAT_W, align: 'right' });
    doc.text('NET', NET_X, top, { width: NET_W, align: 'right' });
    doc.moveTo(MARGIN, top + 13).lineTo(MARGIN + WIDTH, top + 13).lineWidth(0.7).strokeColor('#999999').stroke();
    doc.fillColor('#000');
    return top + 20;
  };
  y = tableHeader(y);

  const rows = inv.lines.map((l) => ({
    description: pdfText(l.description),
    sub: l.sku ? pdfText(`SKU ${l.sku}`) : null,
    quantity: qty(l.quantity),
    unit: gbp(l.unitNetPence),
    vat: rate(l.vatRate),
    net: gbp(l.netPence),
  }));
  if (inv.delivery) {
    rows.push({ description: 'Delivery', sub: null, quantity: '1', unit: gbp(inv.delivery.netPence), vat: rate(inv.delivery.vatRate), net: gbp(inv.delivery.netPence) });
  }

  for (const row of rows) {
    doc.font('Helvetica').fontSize(10);
    const height = doc.heightOfString(row.description, { width: DESC_W }) + (row.sub ? 12 : 0) + 9;
    if (y + height > BODY_BOTTOM) {
      doc.addPage();
      y = tableHeader(MARGIN);
    }
    doc.font('Helvetica').fontSize(10).fillColor('#000').text(row.description, MARGIN, y, { width: DESC_W });
    if (row.sub) doc.font('Helvetica').fontSize(8).fillColor('#666').text(row.sub, MARGIN, doc.y + 1, { width: DESC_W });
    doc.font('Helvetica').fontSize(10).fillColor('#000');
    doc.text(row.quantity, QTY_X, y, { width: QTY_W, align: 'right' });
    doc.text(row.unit, UNIT_X, y, { width: UNIT_W, align: 'right' });
    doc.text(row.vat, VAT_X, y, { width: VAT_W, align: 'right' });
    doc.text(row.net, NET_X, y, { width: NET_W, align: 'right' });
    y += height;
    doc.moveTo(MARGIN, y - 4).lineTo(MARGIN + WIDTH, y - 4).lineWidth(0.3).strokeColor('#dddddd').stroke();
  }

  // ---- Totals and payment ----
  if (y + 90 > BODY_BOTTOM) {
    doc.addPage();
    y = MARGIN;
  }
  y += 8;
  const totals: Array<[string, string, boolean]> = [
    ['Net total', gbp(inv.totals.netPence), false],
    ['VAT', gbp(inv.totals.vatPence), false],
    ['Total (GBP)', gbp(inv.totals.grossPence), true],
  ];
  for (const [label, value, bold] of totals) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor('#000');
    doc.text(label, MARGIN + WIDTH - 280, y, { width: 180, align: 'right' });
    doc.text(value, MARGIN + WIDTH - 90, y, { width: 90, align: 'right' });
    y += bold ? 20 : 15;
  }
  y += 12;
  doc.font('Helvetica').fontSize(9.5).fillColor('#000').text(pdfText(inv.paymentNote), MARGIN, y, { width: WIDTH });

  // ---- Footer on every page ----
  const pages = doc.bufferedPageRange();
  const legal = pdfText(
    `${SELLER.legalName}. Registered in England and Wales, company number ${SELLER.companyNumber}. Registered office: ${SELLER.registeredOffice}. VAT registration number ${SELLER.vatNumber}.`,
  );
  for (let i = pages.start; i < pages.start + pages.count; i++) {
    doc.switchToPage(i);
    // Writing into the bottom margin would otherwise start a new page.
    doc.page.margins.bottom = 0;
    const footerY = A4[1] - MARGIN + 6;
    doc.moveTo(MARGIN, footerY - 6).lineTo(MARGIN + WIDTH, footerY - 6).lineWidth(0.5).strokeColor('#999999').stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor('#555').text(legal, MARGIN, footerY, { width: WIDTH - 70, lineBreak: true });
    if (pages.count > 1) {
      doc.text(`Page ${i - pages.start + 1} of ${pages.count}`, MARGIN + WIDTH - 70, footerY, { width: 70, align: 'right', lineBreak: false });
    }
  }

  doc.end();
  return finished;
}
