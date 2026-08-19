/**
 * The pageSize cap is a CONTRACT, not a courtesy (Aug-2026 feedback, D-1).
 *
 * Asking for more than `MAX_PAGE_SIZE` returns a 400 — it does not silently
 * truncate. That is exactly what made D-1 so hard to see from the venue: the
 * stock-take screen asked for 500, got a 400, and the failure surfaced as
 * unreadable row labels rather than as an error. These tests document the
 * contract so a future client author can find it, and pin the constant the
 * web app mirrors.
 */
import { describe, expect, it } from 'vitest';
import { MAX_PAGE_SIZE, paginationSchema } from './pagination.js';

describe('paginationSchema pageSize cap', () => {
  it('exposes the cap as a shared constant', () => {
    expect(MAX_PAGE_SIZE).toBe(250);
  });

  it('accepts pageSize at the cap', () => {
    const parsed = paginationSchema.parse({ pageSize: String(MAX_PAGE_SIZE) });
    expect(parsed.pageSize).toBe(MAX_PAGE_SIZE);
  });

  it('D-1: rejects pageSize above the cap, with a message naming it', () => {
    const result = paginationSchema.safeParse({ pageSize: '500' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = result.error.issues.map((i) => i.message).join(' ');
    expect(message).toContain(String(MAX_PAGE_SIZE));
  });

  it('defaults to 50 when unset', () => {
    expect(paginationSchema.parse({}).pageSize).toBe(50);
  });
});
