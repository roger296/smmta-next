/**
 * Pick note content: what is listed, in what order, and when the fingerprint
 * changes. Pure — no database or PDF.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPickNoteContent,
  formatLocation,
  pdfText,
  pickNoteHash,
  type PickNoteSource,
  type PickNoteSourceLine,
} from './pick-note-content.js';

const line = (overrides: Partial<PickNoteSourceLine> = {}): PickNoteSourceLine => ({
  productId: 'p-brown',
  sku: 'V3-PLA-BAS-BROWN',
  name: 'Landau PLA Basic 1.75mm 1kg — Brown',
  quantity: 2,
  fulfilmentSource: 'WAREHOUSE',
  locations: [],
  ...overrides,
});

const source = (overrides: Partial<PickNoteSource> = {}): PickNoteSource => ({
  orderNumber: 'STORE-EBE1CE630088',
  orderDate: '2026-09-10',
  sourceChannel: 'STOREFRONT',
  deliveryName: 'Roger Test',
  deliveryPostcode: 'ST7 3PL',
  lines: [line()],
  pickingNotes: [],
  ...overrides,
});

describe('buildPickNoteContent', () => {
  it('lists each item with its quantity, and totals the units', () => {
    const c = buildPickNoteContent(source({ lines: [line(), line({ productId: 'p-white', sku: 'V3-PLA-BAS-WHITE', name: 'White', quantity: 3 })] }));
    expect(c.lines.map((l) => [l.sku, l.quantity])).toEqual([
      ['V3-PLA-BAS-BROWN', 2],
      ['V3-PLA-BAS-WHITE', 3],
    ]);
    expect(c.totalUnits).toBe(5);
    expect(c.deliverTo).toBe('Roger Test, ST7 3PL');
  });

  it('merges two lines for the same product into one pick', () => {
    const c = buildPickNoteContent(source({ lines: [line({ quantity: 1 }), line({ quantity: 4 })] }));
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]!.quantity).toBe(5);
  });

  it('leaves out drop-shipped lines, counting them, and zero-quantity lines', () => {
    const c = buildPickNoteContent(
      source({
        lines: [line(), line({ productId: 'p-ds', sku: 'DS-1', fulfilmentSource: 'SUPPLIER' }), line({ productId: 'p-zero', sku: 'Z-1', quantity: 0 })],
      }),
    );
    expect(c.lines.map((l) => l.sku)).toEqual(['V3-PLA-BAS-BROWN']);
    expect(c.dropShipLines).toBe(1);
  });

  it('sorts into walking order: by location, then items with no location, SKU breaking ties', () => {
    const c = buildPickNoteContent(
      source({
        lines: [
          line({ productId: 'a', sku: 'SKU-10', locations: [] }),
          line({ productId: 'b', sku: 'SKU-2', locations: ['B-1-2'] }),
          line({ productId: 'c', sku: 'SKU-9', locations: ['A-10-1'] }),
          line({ productId: 'd', sku: 'SKU-1', locations: ['A-2-1'] }),
          line({ productId: 'e', sku: 'SKU-3', locations: [] }),
        ],
      }),
    );
    expect(c.lines.map((l) => l.sku)).toEqual(['SKU-1', 'SKU-9', 'SKU-2', 'SKU-3', 'SKU-10']);
  });

  it('prints only the picking notes it was given, cleaned for the PDF fonts', () => {
    const c = buildPickNoteContent(source({ pickingNotes: ['  Gift wrap  please ', 'Fragile ⚠'] }));
    expect(c.notes).toEqual(['Gift wrap please', 'Fragile ?']);
  });
});

describe('pickNoteHash', () => {
  it('is the same however the order lines happen to be ordered', () => {
    const a = source({ lines: [line(), line({ productId: 'w', sku: 'W', quantity: 1 })] });
    const b = source({ lines: [line({ productId: 'w', sku: 'W', quantity: 1 }), line()] });
    expect(pickNoteHash(buildPickNoteContent(a))).toBe(pickNoteHash(buildPickNoteContent(b)));
  });

  it('changes when an item is added or removed, a quantity changes, or a picking note is added', () => {
    const base = pickNoteHash(buildPickNoteContent(source()));
    expect(pickNoteHash(buildPickNoteContent(source({ lines: [line(), line({ productId: 'x', sku: 'X' })] })))).not.toBe(base);
    expect(pickNoteHash(buildPickNoteContent(source({ lines: [] })))).not.toBe(base);
    expect(pickNoteHash(buildPickNoteContent(source({ lines: [line({ quantity: 3 })] })))).not.toBe(base);
    expect(pickNoteHash(buildPickNoteContent(source({ pickingNotes: ['Gift wrap'] })))).not.toBe(base);
  });
});

describe('helpers', () => {
  it('formatLocation joins the parts that are set', () => {
    expect(formatLocation('A', '3', '12')).toBe('A-3-12');
    expect(formatLocation('A', null, ' 7 ')).toBe('A-7');
    expect(formatLocation(null, '', undefined)).toBeNull();
  });

  it('pdfText keeps what the PDF fonts can print and replaces the rest', () => {
    expect(pdfText('Landau PLA — Brown “Matte” £9.25 €5')).toBe('Landau PLA — Brown “Matte” £9.25 €5');
    expect(pdfText('Crème brûlée')).toBe('Crème brûlée');
    // ó is printable as it is; ź loses its accent; Ł has no decomposition, so is mapped.
    expect(pdfText('Łódź')).toBe('Lódz');
    expect(pdfText('滤丝 😀')).toBe('?? ?');
  });
});
