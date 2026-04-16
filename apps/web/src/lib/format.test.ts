import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatMoney, formatPercent } from './format';

describe('formatMoney', () => {
  it('formats GBP with symbol and 2 decimals', () => {
    expect(formatMoney(1234.5, 'GBP')).toBe('£1,234.50');
  });
  it('formats USD', () => {
    expect(formatMoney(99.9, 'USD')).toBe('$99.90');
  });
  it('accepts string numeric input', () => {
    expect(formatMoney('50.00', 'GBP')).toBe('£50.00');
  });
  it('returns — for null', () => {
    expect(formatMoney(null)).toBe('—');
  });
  it('returns — for undefined', () => {
    expect(formatMoney(undefined)).toBe('—');
  });
  it('returns — for NaN input', () => {
    expect(formatMoney('abc')).toBe('—');
  });
  it('falls back to currency code prefix for unknown currency', () => {
    expect(formatMoney(10, 'ZZZ')).toBe('ZZZ 10.00');
  });
});

describe('formatDate', () => {
  it('formats ISO date', () => {
    expect(formatDate('2026-04-16')).toBe('16 Apr 2026');
  });
  it('returns — for null', () => {
    expect(formatDate(null)).toBe('—');
  });
  it('returns — for invalid input', () => {
    expect(formatDate('not-a-date')).toBe('—');
  });
});

describe('formatDateTime', () => {
  it('formats ISO datetime', () => {
    const result = formatDateTime('2026-04-16T13:45:00Z');
    expect(result).toMatch(/16 Apr 2026 \d{2}:\d{2}/);
  });
  it('returns — for null', () => {
    expect(formatDateTime(undefined)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('formats with 1 decimal by default', () => {
    expect(formatPercent(20)).toBe('20.0%');
  });
  it('respects decimals param', () => {
    expect(formatPercent(20.556, 2)).toBe('20.56%');
  });
  it('returns — for null', () => {
    expect(formatPercent(null)).toBe('—');
  });
});
