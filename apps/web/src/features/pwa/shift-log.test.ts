/**
 * The shift log (Sept-2026 user testing, item 9).
 *
 * "Staff noted that users should be able to see what they have submitted during
 *  the current logged in session."
 *
 * Two things make this harder than it reads. Venue iPads are SHARED, so "the
 * current logged in session" has to mean the token, not the device. And some
 * of what a baker filed is still in the offline queue — which is exactly what
 * they are checking on, so it must be shown rather than hidden.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { currentShiftKey, listShift, recordShiftEntry } from './shift-log';
import { tokenWithRoles } from '@/test/tokens';

const SITE = 'site-1';

/** A token with a distinct `iat`, i.e. a distinct sign-in. */
function signIn(iat: number, userId = 'pin:1') {
  const base = tokenWithRoles(['head_baker'], SITE);
  const [header, payload, sig] = base.split('.');
  const claims = JSON.parse(
    atob(payload!.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((payload!.length + 3) % 4)),
  );
  const next = btoa(JSON.stringify({ ...claims, iat, userId }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  localStorage.setItem('smmta_token', `${header}.${next}.${sig}`);
}

beforeEach(() => {
  localStorage.clear();
});

describe('scoping to the sign-in', () => {
  it('records nothing when nobody is signed in', () => {
    // A signed-out screen must show nothing, not the last person's shift.
    recordShiftEntry({ kind: 'WASTAGE', label: 'Wastage — 30 eggs', status: 'sent' });
    expect(listShift()).toEqual([]);
    expect(currentShiftKey()).toBeNull();
  });

  it('keeps one sign-in separate from the next on a shared iPad', () => {
    signIn(1000);
    recordShiftEntry({ kind: 'GOODS_IN', label: 'Goods in — 4 lines', status: 'sent' });
    expect(listShift()).toHaveLength(1);

    signIn(2000); // the next baker taps their PIN
    expect(listShift()).toEqual([]);
  });

  it('does not leave the previous sign-in on the device', () => {
    // A shared venue iPad would otherwise accumulate one log per PIN tap
    // forever, each a record of who did what, kept for no reason anyone asked.
    signIn(1000);
    recordShiftEntry({ kind: 'GOODS_IN', label: 'Goods in — 4 lines', status: 'sent' });
    signIn(2000);
    recordShiftEntry({ kind: 'STOCK_TAKE', label: 'Stock-take — 12 counts', status: 'sent' });

    const keys = Object.keys(localStorage).filter((k) => k.startsWith('autostock_shift_log:'));
    expect(keys).toHaveLength(1);
  });
});

describe('what it shows', () => {
  beforeEach(() => signIn(1000));

  it('lists newest first', () => {
    recordShiftEntry({ kind: 'GOODS_IN', label: 'first', status: 'sent', at: 1 });
    recordShiftEntry({ kind: 'WASTAGE', label: 'second', status: 'sent', at: 2 });
    expect(listShift().map((e) => e.label)).toEqual(['second', 'first']);
  });

  it('keeps a queued job visible, marked as not yet sent', () => {
    // The whole point of the screen is "did that save?". Hiding the queued
    // ones, or counting them as done, is the A-1 lie again.
    recordShiftEntry({ kind: 'CONSUMPTION', label: 'End of bake — Battenburg', status: 'queued' });
    const [entry] = listShift();
    expect(entry!.status).toBe('queued');
  });

  it('carries the detail a baker needs to recognise the entry', () => {
    recordShiftEntry({
      kind: 'CONSUMPTION',
      label: 'End of bake — Battenburg (12 ingredients)',
      detail: 'Session BB-1 · Sam',
      status: 'sent',
    });
    expect(listShift()[0]!.detail).toBe('Session BB-1 · Sam');
  });

  it('survives a corrupt store rather than taking the screen down', () => {
    // An empty shift reads as "nothing yet", which is recoverable. A crash on
    // a venue iPad mid-service is not.
    localStorage.setItem(currentShiftKey()!, 'not json');
    expect(() => listShift()).not.toThrow();
    expect(listShift()).toEqual([]);
  });

  it('caps the log rather than growing without limit', () => {
    for (let i = 0; i < 260; i += 1) {
      recordShiftEntry({ kind: 'STOCK_TAKE', label: `count ${i}`, status: 'sent', at: i });
    }
    const all = listShift();
    expect(all).toHaveLength(200);
    // The oldest go, not the newest — a baker checks what they just did.
    expect(all[0]!.label).toBe('count 259');
  });
});
