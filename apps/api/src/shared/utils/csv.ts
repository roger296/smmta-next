/**
 * CSV reading shared by the importers (orders, products).
 */

/** A heading reduced to letters and digits: "Order Date(dd/mm/yyyy)" → "orderdateddmmyyyy". */
export function normaliseHeading(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Split CSV text into records of fields. Handles CRLF and LF line endings,
 * quoted fields containing commas, doubled quotes and line breaks, and a
 * leading byte-order mark. Every field is trimmed.
 */
export function parseCsvRecords(csvText: string): string[][] {
  const text = csvText.replace(/^﻿/, '');
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      record.push(field.trim());
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field.trim());
      records.push(record);
      record = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field.trim());
    records.push(record);
  }
  return records.filter((r) => !(r.length === 1 && r[0] === ''));
}

/**
 * Rows as objects keyed by normalised heading, with the 1-based line number
 * of each row in the file (the header is line 1). Blank rows are dropped.
 */
export function parseCsvRows(csvText: string): { keys: string[]; rows: Array<{ line: number; values: Record<string, string> }> } {
  const records = parseCsvRecords(csvText);
  if (records.length === 0) return { keys: [], rows: [] };
  const keys = records[0]!.map(normaliseHeading);
  const rows: Array<{ line: number; values: Record<string, string> }> = [];
  for (let i = 1; i < records.length; i++) {
    const values = records[i]!;
    if (values.every((v) => v === '')) continue;
    const row: Record<string, string> = {};
    keys.forEach((k, idx) => {
      if (k === '') return;
      row[k] = values[idx] ?? '';
    });
    rows.push({ line: i + 1, values: row });
  }
  return { keys, rows };
}
