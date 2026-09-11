/**
 * Pick note PDF: page size, the barcode, and flowing a long order onto more
 * labels. Pure rendering — no database.
 */
import { describe, expect, it } from 'vitest';
import { buildPickNoteContent, type PickNoteSourceLine } from './pick-note-content.js';
import { PICK_NOTE_PAGE_PT, renderPickNotePdf } from './pick-note-pdf.js';

function content(lineCount: number, notes: string[] = []) {
  const lines: PickNoteSourceLine[] = Array.from({ length: lineCount }, (_, i) => ({
    productId: `p${i}`,
    sku: `V3-PLA-BAS-${i + 1}`,
    name: `Landau PLA Basic 1.75mm 1kg — Colour number ${i + 1} with a long enough name to wrap`,
    quantity: (i % 3) + 1,
    fulfilmentSource: 'WAREHOUSE',
    locations: i % 2 ? [`A-${i}-1`] : [],
  }));
  return buildPickNoteContent({
    orderNumber: 'STORE-EBE1CE630088',
    orderDate: '2026-09-10',
    sourceChannel: 'STOREFRONT',
    deliveryName: 'Roger Test',
    deliveryPostcode: 'ST7 3PL',
    lines,
    pickingNotes: notes,
  });
}

const render = (c: ReturnType<typeof content>) =>
  renderPickNotePdf(c, { generatedAt: new Date('2026-09-11T09:00:00Z'), compress: false });

/** Page objects, not the /Pages tree node. */
const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

describe('renderPickNotePdf', () => {
  it('produces a PDF on a 4 x 4 inch page', async () => {
    const pdf = await render(content(2));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(PICK_NOTE_PAGE_PT).toBe(288);
    expect(pdf.toString('latin1')).toMatch(/\/MediaBox \[0 0 288 288\]/);
  });

  it('includes the barcode image', async () => {
    const pdf = await render(content(2));
    expect(pdf.toString('latin1')).toMatch(/\/Subtype \/Image/);
  });

  it('fits a short order on one label', async () => {
    expect(pageCount(await render(content(3)))).toBe(1);
  });

  it('flows a long order, with notes, onto further labels', async () => {
    const short = pageCount(await render(content(3)));
    const long = pageCount(await render(content(40, ['Gift wrap please', 'Check the seal on every spool before packing.'])));
    expect(long).toBeGreaterThan(short);
  });

  it('renders an order whose items are all unlocated, and one with a drop-shipped line', async () => {
    const c = content(1);
    const pdf = await render({ ...c, lines: c.lines.map((l) => ({ ...l, location: null })), dropShipLines: 2 });
    expect(pageCount(pdf)).toBe(1);
  });
});
