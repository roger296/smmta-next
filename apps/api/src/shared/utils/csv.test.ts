import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './csv.js';

describe('csvCell', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvCell('Plain Flour')).toBe('Plain Flour');
  });

  it('renders null and undefined as empty, not as the word', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes a value containing a comma', () => {
    expect(csvCell('case of 6, assorted')).toBe('"case of 6, assorted"');
  });

  it('doubles embedded quotes and wraps', () => {
    expect(csvCell('25" sack')).toBe('"25"" sack"');
  });

  it.each([
    ['newline', 'line one\nline two'],
    ['carriage return', 'line one\rline two'],
  ])('quotes a value containing a %s', (_label, value) => {
    expect(csvCell(value)).toBe(`"${value}"`);
  });

  it('renders booleans as true/false rather than 1/0', () => {
    expect(csvCell(true)).toBe('true');
    expect(csvCell(false)).toBe('false');
  });

  it('renders a Date as ISO', () => {
    expect(csvCell(new Date('2026-09-16T10:03:00.000Z'))).toBe('2026-09-16T10:03:00.000Z');
  });

  it('renders a jsonb array as its JSON, so nothing is lost', () => {
    expect(csvCell(['https://a/1.jpg', 'https://a/2.jpg'])).toBe(
      '"[""https://a/1.jpg"",""https://a/2.jpg""]"',
    );
  });

  // The whole point of the guard: these open as live formulas otherwise.
  it.each([
    ['equals', '=1+1'],
    ['plus', '+1'],
    ['at', '@SUM(A1)'],
    ['tab', '\tSUM(A1)'],
  ])('neutralises a leading %s', (_label, value) => {
    expect(csvCell(value).replace(/^"|"$/g, '')).toBe(`'${value}`);
  });

  it('neutralises the classic command-injection payload', () => {
    expect(csvCell(`=cmd|'/C calc'!A1`)).toBe(`'=cmd|'/C calc'!A1`);
  });

  it('leaves a real negative NUMBER untouched', () => {
    expect(csvCell(-12.5)).toBe('-12.5');
  });

  it('leaves a negative numeric STRING untouched', () => {
    // Postgres `numeric` arrives as a string, so every decimal column in the
    // catalogue takes this path. An apostrophe here would turn a negative cost
    // into text and stop it being arithmetic in the sheet.
    expect(csvCell('-12.5')).toBe('-12.5');
    expect(csvCell('-0.001200')).toBe('-0.001200');
  });

  it('still guards a risky string that merely starts like a number', () => {
    expect(csvCell('-lead')).toBe(`'-lead`);
    expect(csvCell('-1+cmd|calc')).toBe(`'-1+cmd|calc`);
  });
});

describe('toCsv', () => {
  const columns = [
    { header: 'Name', value: (r: { name: string; qty: number | null }) => r.name },
    { header: 'Qty', value: (r: { name: string; qty: number | null }) => r.qty },
  ];

  it('writes a header row then one row per record, CRLF terminated', () => {
    const csv = toCsv(columns, [
      { name: 'Flour', qty: 3 },
      { name: 'Sugar, icing', qty: null },
    ]);
    expect(csv).toBe('Name,Qty\r\nFlour,3\r\n"Sugar, icing",\r\n');
  });

  it('writes just the header when there are no rows', () => {
    expect(toCsv(columns, [])).toBe('Name,Qty\r\n');
  });

  it('keeps every row, so the export is never silently short', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ name: `p${i}`, qty: i }));
    expect(toCsv(columns, rows).trimEnd().split('\r\n')).toHaveLength(501);
  });
});
