/**
 * The gate, cell by cell (spec § Email classes): 4 classes × 3 marketing
 * statuses × 5 deliverability values, then each marketing-only gate.
 */
import { describe, expect, it } from 'vitest';
import { canSend, inSendWindow, nextWindowOpening, type GateContact, type GateInput } from './gate.js';
import { defaultSettings } from './settings-defaults.js';
import type { Deliverability, EmailClass, MarketingStatus } from '../../../db/schema/email.js';

// Thursday 5 November 2026, 11:00 UK (GMT).
const NOW = new Date('2026-11-05T11:00:00Z');
const DAY = 86_400_000;

function contact(over: Partial<GateContact> = {}): GateContact {
  return {
    marketingStatus: 'all',
    deliverability: 'ok',
    softBounceCount: 0,
    softBounceSince: null,
    lastMarketingAt: null,
    digestEnabled: true,
    newProductAlertsEnabled: true,
    ...over,
  };
}

function input(cls: EmailClass, over: Partial<GateInput> = {}): GateInput {
  return { class: cls, kind: 'test', now: NOW, settings: defaultSettings(), ...over };
}

const CLASSES: EmailClass[] = ['order_required', 'requested_service', 'service', 'marketing'];
const STATUSES: MarketingStatus[] = ['all', 'transactional_only', 'never'];
const DELIVERABILITY: Deliverability[] = ['ok', 'soft_bounce', 'hard_bounce', 'complained', 'invalid'];

// Expected outcome per cell: true = send, or the refusal reason.
function expected(cls: EmailClass, status: MarketingStatus, d: Deliverability): true | string {
  const statusOk =
    cls === 'order_required' ? true : cls === 'marketing' ? status === 'all' : status !== 'never';
  if (!statusOk) return status === 'never' ? 'never' : 'transactional_only';
  if (cls === 'order_required') return true;
  if (d === 'hard_bounce' || d === 'complained' || d === 'invalid') return d;
  return true; // ok, or a soft bounce under the limit
}

describe('canSend — the class table (60 cells)', () => {
  const cells = CLASSES.flatMap((cls) =>
    STATUSES.flatMap((status) => DELIVERABILITY.map((d) => [cls, status, d] as const)),
  );
  it('covers 60 cells', () => expect(cells).toHaveLength(60));

  it.each(cells)('%s / %s / %s', (cls, status, d) => {
    const c = contact({
      marketingStatus: status,
      deliverability: d,
      softBounceCount: d === 'soft_bounce' ? 1 : 0,
      softBounceSince: d === 'soft_bounce' ? new Date(NOW.getTime() - DAY) : null,
    });
    const want = expected(cls, status, d);
    const got = canSend(c, input(cls));
    if (want === true) expect(got).toEqual({ ok: true });
    else expect(got).toEqual({ ok: false, reason: want });
  });
});

describe('canSend — soft bounces', () => {
  it('three soft bounces in 30 days count as hard-bounced, except for order-required mail', () => {
    const c = contact({
      deliverability: 'soft_bounce',
      softBounceCount: 3,
      softBounceSince: new Date(NOW.getTime() - 10 * DAY),
    });
    expect(canSend(c, input('requested_service'))).toEqual({ ok: false, reason: 'soft_bounce_limit' });
    expect(canSend(c, input('marketing'))).toEqual({ ok: false, reason: 'soft_bounce_limit' });
    expect(canSend(c, input('order_required'))).toEqual({ ok: true });
  });

  it('three soft bounces spread over more than 30 days do not', () => {
    const c = contact({
      deliverability: 'soft_bounce',
      softBounceCount: 3,
      softBounceSince: new Date(NOW.getTime() - 40 * DAY),
    });
    expect(canSend(c, input('marketing'))).toEqual({ ok: true });
  });
});

describe('canSend — marketing gates', () => {
  it('refuses everything marketing while paused, and nothing else', () => {
    const s = { ...defaultSettings(), marketing_paused: true };
    expect(canSend(contact(), input('marketing', { settings: s }))).toEqual({ ok: false, reason: 'paused' });
    expect(canSend(contact(), input('requested_service', { settings: s }))).toEqual({ ok: true });
  });

  it('keeps the 7-day gap', () => {
    const c = contact({ lastMarketingAt: new Date(NOW.getTime() - 3 * DAY) });
    expect(canSend(c, input('marketing'))).toEqual({ ok: false, reason: 'gap' });
    const later = contact({ lastMarketingAt: new Date(NOW.getTime() - 7 * DAY - 1) });
    expect(canSend(later, input('marketing'))).toEqual({ ok: true });
  });

  it('lets a hero campaign skip the gap but never the 24-hour floor', () => {
    const three = contact({ lastMarketingAt: new Date(NOW.getTime() - 3 * DAY) });
    expect(canSend(three, input('marketing', { overrideGap: true }))).toEqual({ ok: true });
    const twelveHours = contact({ lastMarketingAt: new Date(NOW.getTime() - DAY / 2) });
    expect(canSend(twelveHours, input('marketing', { overrideGap: true }))).toEqual({ ok: false, reason: 'gap' });
  });

  it('keeps the 24-hour floor even when the gap setting is lowered to 0', () => {
    const s = { ...defaultSettings(), marketing_min_gap_days: 0 };
    const c = contact({ lastMarketingAt: new Date(NOW.getTime() - 3_600_000) });
    expect(canSend(c, input('marketing', { settings: s }))).toEqual({ ok: false, reason: 'gap' });
  });

  it('moves a contact with six unengaged marketing emails to a quarterly cadence', () => {
    const c = contact({ lastMarketingAt: new Date(NOW.getTime() - 30 * DAY) });
    expect(canSend(c, input('marketing', { unengagedStreak: 6 }))).toEqual({ ok: false, reason: 'unengaged' });
    expect(canSend(c, input('marketing', { unengagedStreak: 5 }))).toEqual({ ok: true });
    const quarter = contact({ lastMarketingAt: new Date(NOW.getTime() - 91 * DAY) });
    expect(canSend(quarter, input('marketing', { unengagedStreak: 6 }))).toEqual({ ok: true });
  });

  it('sends marketing only between 08:00 and 20:00 UK time, when asked to check', () => {
    const night = new Date('2026-11-05T21:30:00Z');
    expect(canSend(contact(), input('marketing', { now: night, checkWindow: true }))).toEqual({
      ok: false,
      reason: 'window',
    });
    expect(canSend(contact(), input('requested_service', { now: night, checkWindow: true }))).toEqual({ ok: true });
    expect(canSend(contact(), input('marketing', { now: night }))).toEqual({ ok: true });
  });

  it('honours the digest and new-product switches for their own kinds only', () => {
    const c = contact({ digestEnabled: false, newProductAlertsEnabled: false });
    expect(canSend(c, input('marketing', { kind: 'weekly_digest' }))).toEqual({ ok: false, reason: 'digest_disabled' });
    expect(canSend(c, input('marketing', { kind: 'new_product' }))).toEqual({
      ok: false,
      reason: 'new_product_disabled',
    });
    expect(canSend(c, input('marketing', { kind: 'manual' }))).toEqual({ ok: true });
  });
});

describe('send window', () => {
  const w = { start: '08:00', end: '20:00', timezone: 'Europe/London' };
  it('uses UK local time across the clock change', () => {
    // 07:30 UTC in July is 08:30 BST — inside.
    expect(inSendWindow(new Date('2026-07-01T07:30:00Z'), w)).toBe(true);
    // 07:30 UTC in November is 07:30 GMT — outside.
    expect(inSendWindow(new Date('2026-11-05T07:30:00Z'), w)).toBe(false);
  });
  it('finds the next opening', () => {
    expect(nextWindowOpening(new Date('2026-11-05T21:00:00Z'), w).toISOString()).toBe('2026-11-06T08:00:00.000Z');
  });
});
