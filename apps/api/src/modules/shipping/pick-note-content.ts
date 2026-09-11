/**
 * What goes on a pick note, built from an order. Pure: no database, no PDF.
 *
 * The content hash is the pick note's fingerprint. A stored note is current
 * while its hash matches the order's content, so any change to what has to be
 * picked — an item added or removed, a quantity changed, a picking instruction
 * added — makes it stale and it is re-created, whichever code path made the
 * change.
 */
import { createHash } from 'node:crypto';

export interface PickNoteSourceLine {
  productId: string;
  sku: string | null;
  name: string;
  quantity: number;
  fulfilmentSource: 'WAREHOUSE' | 'SUPPLIER';
  /** Formatted stock locations for this product, e.g. "A-3-12". */
  locations: string[];
}

export interface PickNoteSource {
  orderNumber: string;
  /** YYYY-MM-DD. */
  orderDate: string;
  sourceChannel: string;
  deliveryName: string | null;
  deliveryPostcode: string | null;
  lines: PickNoteSourceLine[];
  /** Order notes flagged as picking notes, oldest first. */
  pickingNotes: string[];
}

export interface PickLine {
  sku: string;
  name: string;
  quantity: number;
  location: string | null;
}

export interface PickNoteContent {
  orderNumber: string;
  orderDate: string;
  channel: string;
  deliverTo: string | null;
  lines: PickLine[];
  notes: string[];
  totalUnits: number;
  /** Lines that ship direct from a supplier, so are not picked here. */
  dropShipLines: number;
}

const natural = (a: string, b: string) => a.localeCompare(b, 'en-GB', { numeric: true, sensitivity: 'base' });
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Characters outside Latin-1 that the PDF standard fonts (WinAnsi) can still print. */
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

/** Letters with no Unicode decomposition to strip an accent from, and their plain form. */
const PLAIN_LETTER: Record<string, string> = {
  Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', Ħ: 'H', ħ: 'h', ı: 'i', Ŀ: 'L', ŀ: 'l', Ŧ: 'T', ŧ: 't',
};

/**
 * Text the built-in PDF fonts can print. They cover Latin-1 plus a few extras;
 * anything else would print as garbage, so accents are stripped where that
 * leaves plain letters and the rest become "?".
 */
export function pdfText(value: string): string {
  return Array.from(value.normalize('NFC').replace(/\s+/g, ' ').trim())
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.includes(ch)) return ch;
      if (PLAIN_LETTER[ch]) return PLAIN_LETTER[ch]!;
      const stripped = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      return /^[\x20-\x7e]+$/.test(stripped) ? stripped : '?';
    })
    .join('');
}

/** "A", "3", "12" → "A-3-12". Null when no part is set. */
export function formatLocation(
  aisle: string | null | undefined,
  shelf: string | null | undefined,
  bin: string | null | undefined,
): string | null {
  const parts = [aisle, shelf, bin].map((p) => (p ?? '').trim()).filter(Boolean);
  return parts.length > 0 ? parts.join('-') : null;
}

export function buildPickNoteContent(src: PickNoteSource): PickNoteContent {
  const merged = new Map<string, { sku: string; name: string; quantity: number; locations: Set<string> }>();
  let dropShipLines = 0;

  for (const line of src.lines) {
    if (line.fulfilmentSource === 'SUPPLIER') {
      dropShipLines++;
      continue;
    }
    if (!(line.quantity > 0)) continue;
    // The same product on two lines is one trip to the shelf.
    const existing = merged.get(line.productId);
    if (existing) {
      existing.quantity += line.quantity;
      for (const loc of line.locations) existing.locations.add(pdfText(loc));
      continue;
    }
    merged.set(line.productId, {
      sku: pdfText(line.sku ?? ''),
      name: pdfText(line.name),
      quantity: line.quantity,
      locations: new Set(line.locations.map(pdfText).filter(Boolean)),
    });
  }

  // Walking order: located items by location, then anything without one; SKU
  // breaks ties so the list is identical every time it is built.
  const lines: PickLine[] = [...merged.values()]
    .map((m) => ({
      sku: m.sku,
      name: m.name,
      quantity: round3(m.quantity),
      location: m.locations.size > 0 ? [...m.locations].sort(natural).slice(0, 3).join(', ') : null,
    }))
    .sort(
      (a, b) =>
        Number(a.location === null) - Number(b.location === null) ||
        natural(a.location ?? '', b.location ?? '') ||
        natural(a.sku, b.sku) ||
        natural(a.name, b.name),
    );

  const deliverTo = [src.deliveryName, src.deliveryPostcode]
    .map((p) => pdfText(p ?? ''))
    .filter(Boolean)
    .join(', ');

  return {
    orderNumber: pdfText(src.orderNumber),
    orderDate: src.orderDate,
    channel: pdfText(src.sourceChannel),
    deliverTo: deliverTo || null,
    lines,
    notes: src.pickingNotes.map(pdfText).filter(Boolean),
    totalUnits: round3(lines.reduce((sum, l) => sum + l.quantity, 0)),
    dropShipLines,
  };
}

/** The note's fingerprint: equal hashes mean the printed note is still right. */
export function pickNoteHash(content: PickNoteContent): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
