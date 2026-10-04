/**
 * The date rules of the stock-take report: London calendar days, inclusive,
 * and a take counts if it was opened OR approved in the range.
 */
import { describe, expect, it } from 'vitest';
import { inRange, londonDay, londonStamp } from './report-stock-takes.js';

describe('londonDay / londonStamp', () => {
  it('uses the London calendar, not UTC (23:30 UTC in BST is the next day)', () => {
    expect(londonDay('2026-09-30T23:30:00Z')).toBe('2026-10-01');
    expect(londonDay('2026-12-31T23:30:00Z')).toBe('2026-12-31'); // GMT
    expect(londonStamp('2026-09-30T14:47:00Z')).toBe('30/09/2026 15:47');
    expect(londonStamp(null)).toBe('');
  });
});

describe('inRange', () => {
  const from = '2026-09-25';
  const to = '2026-10-03';
  it('includes a take opened in the range', () => {
    expect(inRange({ createdAt: '2026-09-30T09:00:00Z', approvedAt: null }, from, to)).toBe(true);
  });
  it('includes a take opened before but approved in it', () => {
    expect(inRange({ createdAt: '2026-09-20T09:00:00Z', approvedAt: '2026-09-26T09:00:00Z' }, from, to)).toBe(true);
  });
  it('the end day is inclusive, on London time', () => {
    expect(inRange({ createdAt: '2026-10-03T23:30:00Z', approvedAt: null }, from, to)).toBe(false); // 00:30 on 4 Oct, London
    expect(inRange({ createdAt: '2026-10-03T22:00:00Z', approvedAt: null }, from, '2026-10-04')).toBe(true);
    expect(inRange({ createdAt: '2026-10-03T20:00:00Z', approvedAt: null }, from, to)).toBe(true);
  });
  it('leaves out a take entirely outside it', () => {
    expect(inRange({ createdAt: '2026-09-01T09:00:00Z', approvedAt: '2026-09-02T09:00:00Z' }, from, to)).toBe(false);
  });
});
