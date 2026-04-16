import { describe, expect, it } from 'vitest';
import { parseCSVLine, parseCSVPreview } from './use-integrations';

describe('parseCSVLine', () => {
  it('splits simple comma-separated values', () => {
    expect(parseCSVLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });
  it('handles quoted fields with commas inside', () => {
    expect(parseCSVLine('"Smith, John",Acme Ltd,42')).toEqual(['Smith, John', 'Acme Ltd', '42']);
  });
  it('handles escaped double-quotes inside quoted fields', () => {
    expect(parseCSVLine('"He said ""hi""",b')).toEqual(['He said "hi"', 'b']);
  });
  it('returns empty string for missing trailing fields', () => {
    expect(parseCSVLine('a,,c')).toEqual(['a', '', 'c']);
  });
});

describe('parseCSVPreview', () => {
  it('returns headers + rows from CSV text', () => {
    const csv = 'Name,Qty\nWidget,5\nGadget,3';
    const out = parseCSVPreview(csv);
    expect(out.error).toBeUndefined();
    expect(out.headers).toEqual(['Name', 'Qty']);
    expect(out.rows).toEqual([
      { Name: 'Widget', Qty: '5' },
      { Name: 'Gadget', Qty: '3' },
    ]);
  });

  it('honors maxRows', () => {
    const csv = 'A,B\n1,2\n3,4\n5,6\n7,8';
    const out = parseCSVPreview(csv, 2);
    expect(out.rows).toHaveLength(2);
  });

  it('returns error on empty input', () => {
    expect(parseCSVPreview('').error).toBe('Empty CSV');
  });

  it('handles CRLF line endings', () => {
    const out = parseCSVPreview('A,B\r\n1,2');
    expect(out.rows).toEqual([{ A: '1', B: '2' }]);
  });
});
