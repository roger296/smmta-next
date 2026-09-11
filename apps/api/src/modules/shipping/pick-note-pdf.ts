/**
 * Renders a pick note as a PDF for a 4 x 4 inch label printer.
 *
 * Laid out for a thermal printer: black only, bold quantities, a tick box per
 * item, and a Code 128 barcode of the order number so it can be scanned at
 * dispatch. A long order flows onto further labels, each numbered "Page x of y"
 * and headed with the order number, so a dropped label can be put back.
 *
 * Uses the PDF standard fonts, so nothing has to be shipped with the app; the
 * content builder has already reduced text to characters those fonts can print.
 */
import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import type { PickNoteContent } from './pick-note-content.js';

/** 4 inches, in PDF points. */
export const PICK_NOTE_PAGE_PT = 288;

const MARGIN = 12;
const WIDTH = PICK_NOTE_PAGE_PT - MARGIN * 2;
const FOOTER_HEIGHT = 14;
/** Lowest point the body may reach; the footer sits below it. */
const BODY_BOTTOM = PICK_NOTE_PAGE_PT - MARGIN - FOOTER_HEIGHT;

const CHECKBOX = 9;
const QTY_X = MARGIN + CHECKBOX + 5;
const QTY_WIDTH = 26;
const ITEM_X = QTY_X + QTY_WIDTH + 4;
const LOCATION_WIDTH = 50;
const NAME_MAX_HEIGHT = 19; // two lines at 7.5pt

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-09-10 → 10 Sep 2026, without going through a timezone. */
function formatDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return isoDate;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

function formatQuantity(q: number): string {
  return Number.isInteger(q) ? String(q) : String(Math.round(q * 1000) / 1000);
}

const plural = (n: number, word: string) => `${formatQuantity(n)} ${word}${n === 1 ? '' : 's'}`;

export async function renderPickNotePdf(
  content: PickNoteContent,
  opts: { generatedAt: Date; compress?: boolean },
): Promise<Buffer> {
  const barcode = await bwipjs.toBuffer({
    bcid: 'code128',
    text: content.orderNumber,
    scale: 3,
    height: 9,
    includetext: false,
    // The quiet zone either side is part of the symbol; scanners need it.
    paddingwidth: 10,
  });

  const doc = new PDFDocument({
    size: [PICK_NOTE_PAGE_PT, PICK_NOTE_PAGE_PT],
    margin: MARGIN,
    bufferPages: true,
    compress: opts.compress ?? true,
    info: { Title: `Pick note ${content.orderNumber}`, Creator: 'SMMTA-Next', CreationDate: opts.generatedAt },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const hasLocations = content.lines.some((l) => l.location);
  const itemWidth = MARGIN + WIDTH - ITEM_X - (hasLocations ? LOCATION_WIDTH + 4 : 0);

  const rule = (y: number) => {
    doc.moveTo(MARGIN, y).lineTo(MARGIN + WIDTH, y).lineWidth(0.5).stroke();
  };

  const tableHeader = (y: number): number => {
    doc.font('Helvetica-Bold').fontSize(6.5);
    doc.text('QTY', QTY_X, y, { width: QTY_WIDTH, lineBreak: false });
    doc.text('ITEM', ITEM_X, y, { width: itemWidth, lineBreak: false });
    if (hasLocations) {
      doc.text('LOCATION', MARGIN + WIDTH - LOCATION_WIDTH, y, { width: LOCATION_WIDTH, align: 'right', lineBreak: false });
    }
    rule(y + 9);
    return y + 12;
  };

  const newPage = (): number => {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(9).text(`PICK NOTE  ${content.orderNumber}  (continued)`, MARGIN, MARGIN, {
      width: WIDTH,
      lineBreak: false,
    });
    rule(MARGIN + 13);
    return tableHeader(MARGIN + 17);
  };

  // ---- First-page header ----
  let y = MARGIN;
  doc.font('Helvetica-Bold').fontSize(9).text('PICK NOTE', MARGIN, y, { width: WIDTH / 2, lineBreak: false });
  doc.font('Helvetica').fontSize(8).text(formatDate(content.orderDate), MARGIN + WIDTH / 2, y + 1, {
    width: WIDTH / 2,
    align: 'right',
    lineBreak: false,
  });
  y += 13;
  doc.image(barcode, MARGIN, y, { fit: [WIDTH, 34], align: 'center' });
  y += 37;
  doc.font('Helvetica-Bold').fontSize(13).text(content.orderNumber, MARGIN, y, { width: WIDTH, align: 'center', lineBreak: false });
  y += 16;
  const meta = [content.deliverTo, content.channel].filter(Boolean).join('  ·  ');
  if (meta) {
    doc.font('Helvetica').fontSize(7.5).text(meta, MARGIN, y, { width: WIDTH, align: 'center', lineBreak: false, ellipsis: true });
    y += 11;
  }
  rule(y);
  y = tableHeader(y + 4);

  // ---- Items ----
  for (const line of content.lines) {
    doc.font('Helvetica').fontSize(7.5);
    const nameHeight = Math.min(doc.heightOfString(line.name, { width: itemWidth }), NAME_MAX_HEIGHT);
    const rowHeight = Math.max(18, 10 + nameHeight) + 4;
    if (y + rowHeight > BODY_BOTTOM) y = newPage();

    doc.rect(MARGIN, y + 1, CHECKBOX, CHECKBOX).lineWidth(0.8).stroke();
    doc.font('Helvetica-Bold').fontSize(12).text(formatQuantity(line.quantity), QTY_X, y - 1, {
      width: QTY_WIDTH,
      lineBreak: false,
    });
    doc.font('Helvetica-Bold').fontSize(8).text(line.sku || '-', ITEM_X, y, { width: itemWidth, lineBreak: false, ellipsis: true });
    doc.font('Helvetica').fontSize(7.5).text(line.name, ITEM_X, y + 10, {
      width: itemWidth,
      height: NAME_MAX_HEIGHT,
      ellipsis: true,
    });
    if (line.location) {
      doc.font('Helvetica-Bold').fontSize(8).text(line.location, MARGIN + WIDTH - LOCATION_WIDTH, y, {
        width: LOCATION_WIDTH,
        align: 'right',
        height: NAME_MAX_HEIGHT,
        ellipsis: true,
      });
    }
    y += rowHeight;
    doc.moveTo(ITEM_X, y - 2).lineTo(MARGIN + WIDTH, y - 2).lineWidth(0.25).stroke();
  }

  // ---- Drop-ship reminder and picking notes ----
  if (content.dropShipLines > 0) {
    if (y + 12 > BODY_BOTTOM) y = newPage();
    doc.font('Helvetica-Oblique').fontSize(7).text(
      `+ ${plural(content.dropShipLines, 'line')} ship direct from a supplier: not picked here.`,
      MARGIN,
      y + 2,
      { width: WIDTH, lineBreak: false, ellipsis: true },
    );
    y += 12;
  }

  for (const [i, note] of content.notes.entries()) {
    doc.font('Helvetica').fontSize(8);
    const noteHeight = doc.heightOfString(note, { width: WIDTH });
    const needed = (i === 0 ? 11 : 0) + Math.min(noteHeight, BODY_BOTTOM - MARGIN - 40) + 3;
    if (y + needed > BODY_BOTTOM) y = newPage();
    if (i === 0) {
      doc.font('Helvetica-Bold').fontSize(6.5).text('NOTES', MARGIN, y + 3, { width: WIDTH, lineBreak: false });
      y += 11;
    }
    doc.font('Helvetica').fontSize(8).text(note, MARGIN, y, {
      width: WIDTH,
      height: BODY_BOTTOM - y,
      ellipsis: true,
    });
    y += Math.min(noteHeight, BODY_BOTTOM - y) + 3;
  }

  // ---- Footer on every page ----
  const pages = doc.bufferedPageRange();
  const summary = `${plural(content.lines.length, 'line')}  ·  ${plural(content.totalUnits, 'unit')}`;
  for (let i = pages.start; i < pages.start + pages.count; i++) {
    doc.switchToPage(i);
    // Writing into the bottom margin would otherwise start a new page.
    doc.page.margins.bottom = 0;
    const footerY = PICK_NOTE_PAGE_PT - MARGIN - 8;
    rule(footerY - 3);
    doc.font('Helvetica').fontSize(6.5).text(summary, MARGIN, footerY, { width: WIDTH / 2, lineBreak: false });
    doc.text(`Page ${i - pages.start + 1} of ${pages.count}`, MARGIN + WIDTH / 2, footerY, {
      width: WIDTH / 2,
      align: 'right',
      lineBreak: false,
    });
  }

  doc.end();
  return finished;
}
