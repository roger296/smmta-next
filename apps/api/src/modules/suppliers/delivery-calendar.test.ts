/**
 * The delivery calendar (supplier-ordering groundwork). Pure — every case pins
 * `now` and the site's time zone. 29 Sept 2026 is a Tuesday, in BST.
 */
import { describe, expect, it } from 'vitest';
import { addDays, localNow, nextDelivery, weekdayOf } from './delivery-calendar.js';

const LONDON = 'Europe/London';
const at = (iso: string) => new Date(iso);
const brakes = { deliveryDays: ['TUE', 'THU'], cutoffTime: '16:00:00', cutoffDaysBefore: 1, leadDays: null };

describe('calendar helpers', () => {
  it('knows the weekday of a date', () => {
    expect(weekdayOf('2026-09-29')).toBe('TUE');
    expect(weekdayOf('2026-10-04')).toBe('SUN');
  });

  it('reads the SITE wall clock, not UTC', () => {
    // 23:30 UTC on the 29th is 00:30 on the 30th in London (BST).
    expect(localNow(at('2026-09-29T23:30:00Z'), LONDON)).toEqual({ date: '2026-09-30', time: '00:30' });
    // Dallas is five hours behind UTC in September.
    expect(localNow(at('2026-09-29T03:00:00Z'), 'America/Chicago').date).toBe('2026-09-28');
  });

  it('adds days across a month end', () => {
    expect(addDays('2026-09-29', 3)).toBe('2026-10-02');
  });
});

describe('a round (fixed delivery days + cut-off)', () => {
  it('Tuesday morning: Thursday, order by Wednesday 16:00', () => {
    expect(nextDelivery(brakes, at('2026-09-29T09:00:00Z'), LONDON)).toEqual({
      deliveryDate: '2026-10-01',
      orderByLocal: '2026-09-30 16:00',
      basis: 'ROUND',
    });
  });

  it('Wednesday 15:59 London still makes Thursday', () => {
    expect(nextDelivery(brakes, at('2026-09-30T14:59:00Z'), LONDON)?.deliveryDate).toBe('2026-10-01');
  });

  it('Wednesday 16:01 London misses it: next Tuesday', () => {
    const next = nextDelivery(brakes, at('2026-09-30T15:01:00Z'), LONDON);
    expect(next).toEqual({ deliveryDate: '2026-10-06', orderByLocal: '2026-10-05 16:00', basis: 'ROUND' });
  });

  it('a cut-off two days before is honoured', () => {
    const early = { ...brakes, cutoffDaysBefore: 2 };
    // Tuesday 09:00: Thursday needs ordering by Tuesday 16:00 — still open.
    expect(nextDelivery(early, at('2026-09-29T08:00:00Z'), LONDON)?.deliveryDate).toBe('2026-10-01');
    // Tuesday 17:00: too late for Thursday; next Tuesday (order by Sunday).
    expect(nextDelivery(early, at('2026-09-29T16:00:00Z'), LONDON)).toMatchObject({
      deliveryDate: '2026-10-06',
      orderByLocal: '2026-10-04 16:00',
    });
  });

  it('same-day delivery when the cut-off is that morning', () => {
    const lwc = { deliveryDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], cutoffTime: '10:00', cutoffDaysBefore: 0, leadDays: null };
    expect(nextDelivery(lwc, at('2026-09-29T08:00:00Z'), LONDON)?.deliveryDate).toBe('2026-09-29');
    expect(nextDelivery(lwc, at('2026-09-29T10:00:00Z'), LONDON)?.deliveryDate).toBe('2026-09-30');
  });

  it('no cut-off time means any time on the order day', () => {
    const open = { ...brakes, cutoffTime: null };
    expect(nextDelivery(open, at('2026-09-30T22:00:00Z'), LONDON)).toEqual({
      deliveryDate: '2026-10-01',
      orderByLocal: null,
      basis: 'ROUND',
    });
  });

  it('day codes are case-insensitive', () => {
    expect(nextDelivery({ ...brakes, deliveryDays: ['thu'] }, at('2026-09-29T09:00:00Z'), LONDON)?.deliveryDate).toBe(
      '2026-10-01',
    );
  });
});

describe('a lead time (no round)', () => {
  const culpitt = { deliveryDays: [], cutoffTime: '12:00', cutoffDaysBefore: 1, leadDays: 1 };

  it('before midday Tuesday: Wednesday', () => {
    expect(nextDelivery(culpitt, at('2026-09-29T10:00:00Z'), LONDON)).toEqual({
      deliveryDate: '2026-09-30',
      orderByLocal: '2026-09-29 12:00',
      basis: 'LEAD_TIME',
    });
  });

  it('after midday Friday: Tuesday (counts from Monday, skips the weekend)', () => {
    expect(nextDelivery(culpitt, at('2026-10-02T12:30:00Z'), LONDON)).toMatchObject({
      deliveryDate: '2026-10-06',
      orderByLocal: '2026-10-05 12:00',
    });
  });

  it('ordered on a Saturday counts from Monday', () => {
    const amazon = { deliveryDays: [], cutoffTime: null, cutoffDaysBefore: 1, leadDays: 2 };
    expect(nextDelivery(amazon, at('2026-10-03T10:00:00Z'), LONDON)?.deliveryDate).toBe('2026-10-07');
  });
});

it('an account with neither a round nor a lead time cannot be dated', () => {
  expect(
    nextDelivery({ deliveryDays: [], cutoffTime: '16:00', cutoffDaysBefore: 1, leadDays: null }, new Date(), LONDON),
  ).toBeNull();
});
