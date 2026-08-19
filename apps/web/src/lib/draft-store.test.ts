/**
 * Unfinished work survives a reload (Aug-2026 feedback set, A-5).
 *
 * "Lack of visual feedback on screen exits leaves users uncertain whether
 * inputs are saved, deleted, or processed." A half-entered delivery lived only
 * in React state, so a stray reload took it silently.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { clearDraft, draftKey, loadDraft, saveDraft } from './draft-store';

interface Line {
  productId: string;
  qty: number;
}

const LINES: Line[] = [
  { productId: 'icing', qty: 4 },
  { productId: 'skittles', qty: 4 },
];

beforeEach(() => localStorage.clear());

describe('draft persistence', () => {
  it('round-trips a draft', () => {
    saveDraft('goods-in', 'site-1', LINES);
    const restored = loadDraft<Line[]>('goods-in', 'site-1');
    expect(restored?.value).toEqual(LINES);
    expect(typeof restored?.savedAt).toBe('number');
  });

  it('A-5: is scoped per SITE — a switch does not resurrect another venue\'s draft', () => {
    saveDraft('goods-in', 'site-london-south', LINES);
    // Restoring London South's delivery at Birmingham would be a worse bug
    // than losing it, on the very screen whose venue confusion caused E-1.
    expect(loadDraft<Line[]>('goods-in', 'site-birmingham')).toBeNull();
    expect(loadDraft<Line[]>('goods-in', 'site-london-south')?.value).toEqual(LINES);
  });

  it('is scoped per SCREEN — a stock-take draft is not a goods-in draft', () => {
    saveDraft('goods-in', 'site-1', LINES);
    expect(loadDraft('stock-take', 'site-1')).toBeNull();
  });

  it('distinguishes "no site" from a real site', () => {
    saveDraft('goods-in', null, LINES);
    expect(loadDraft<Line[]>('goods-in', null)?.value).toEqual(LINES);
    expect(loadDraft('goods-in', 'site-1')).toBeNull();
  });

  it('clearing removes it', () => {
    saveDraft('goods-in', 'site-1', LINES);
    clearDraft('goods-in', 'site-1');
    expect(loadDraft('goods-in', 'site-1')).toBeNull();
  });

  it('returns null rather than throwing on corrupt storage', () => {
    localStorage.setItem(draftKey('goods-in', 'site-1'), 'not json');
    expect(loadDraft('goods-in', 'site-1')).toBeNull();
  });

  it('returns null on a payload missing its timestamp', () => {
    localStorage.setItem(draftKey('goods-in', 'site-1'), JSON.stringify({ value: LINES }));
    expect(loadDraft('goods-in', 'site-1')).toBeNull();
  });

  it('does not throw when storage is unavailable', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    // A lost draft is bad; a crashed venue screen is worse, and the work is
    // still on screen either way.
    expect(() => saveDraft('goods-in', 'site-1', LINES)).not.toThrow();
    setItem.mockRestore();
  });
});
