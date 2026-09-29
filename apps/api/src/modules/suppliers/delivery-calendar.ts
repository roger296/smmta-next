/**
 * When does an order placed now arrive, and by when must it be placed?
 *
 * The one reader of what a `supplier_site_accounts` row's delivery columns
 * MEAN (docs/plans/SUPPLIER_ORDERING_PLAN.md §4.2 step 2). An account
 * describes its deliveries one of two ways:
 *
 *   - a ROUND: the supplier delivers on fixed weekdays (`deliveryDays`), and an
 *     order must be in by `cutoffTime`, `cutoffDaysBefore` days before the
 *     delivery day. Brakes to London East: TUE/THU, 16:00 the day before.
 *   - a LEAD TIME: `leadDays` working days (Mon–Fri) after the order day; an
 *     order after `cutoffTime` counts as placed the next working day. A web
 *     shop or courier with no round.
 *
 * All times are the SITE's wall clock, because that is what a supplier quotes
 * ("order by 4pm") and what the person ordering sees. Bank holidays are not
 * modelled: a round that falls on one is the supplier's to move, and the
 * confirmation carries the real date.
 *
 * Pure: `now` and the time zone are arguments, so every case is testable.
 */

export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface DeliveryTerms {
  deliveryDays: readonly string[];
  /** "HH:MM" or "HH:MM:SS"; null = any time that day. */
  cutoffTime: string | null;
  cutoffDaysBefore: number;
  leadDays: number | null;
}

export interface NextDelivery {
  /** YYYY-MM-DD, the site's calendar. */
  deliveryDate: string;
  /** "YYYY-MM-DD HH:MM" site wall clock — the last moment to order for that
   *  date. Null when the account has no cut-off time. */
  orderByLocal: string | null;
  basis: 'ROUND' | 'LEAD_TIME';
}

/** How far ahead a round is searched. Two weeks covers a fortnightly round
 *  with a cut-off a week before; anything longer is a data error. */
const SEARCH_DAYS = 21;

/** The site-local date and "HH:MM" of an instant. */
export function localNow(now: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + days));
  return t.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): Weekday {
  const [y, m, d] = date.split('-').map(Number);
  // getUTCDay: 0 = Sunday. WEEKDAYS starts on Monday.
  return WEEKDAYS[(new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7]!;
}

const hhmm = (t: string | null): string | null => (t ? t.slice(0, 5) : null);
const isWorkingDay = (date: string): boolean => !['SAT', 'SUN'].includes(weekdayOf(date));

/**
 * The earliest delivery an order placed at `now` can make, or null when the
 * account describes neither a round nor a lead time (it cannot be ranked on
 * arrival — the data-health page lists it).
 */
export function nextDelivery(terms: DeliveryTerms, now: Date, timeZone: string): NextDelivery | null {
  const { date: today, time: nowTime } = localNow(now, timeZone);
  const cutoff = hhmm(terms.cutoffTime);
  const days = new Set(terms.deliveryDays.map((d) => d.toUpperCase()));

  if (days.size > 0) {
    for (let offset = 0; offset <= SEARCH_DAYS; offset++) {
      const candidate = addDays(today, offset);
      if (!days.has(weekdayOf(candidate))) continue;
      const orderDay = addDays(candidate, -terms.cutoffDaysBefore);
      // Still open if the order day is later than today, or it is today and
      // the cut-off has not passed. Comparing "YYYY-MM-DD HH:MM" strings is a
      // correct chronological comparison.
      const deadline = `${orderDay} ${cutoff ?? '23:59'}`;
      if (`${today} ${nowTime}` <= deadline && orderDay >= today) {
        return { deliveryDate: candidate, orderByLocal: cutoff ? deadline : null, basis: 'ROUND' };
      }
    }
    return null;
  }

  if (terms.leadDays != null) {
    // The order counts as placed today if today is a working day before the
    // cut-off; otherwise the next working day.
    let orderDay = today;
    if (!isWorkingDay(orderDay) || (cutoff && nowTime > cutoff)) {
      do orderDay = addDays(orderDay, 1);
      while (!isWorkingDay(orderDay));
    }
    let delivery = orderDay;
    let remaining = terms.leadDays;
    while (remaining > 0) {
      delivery = addDays(delivery, 1);
      if (isWorkingDay(delivery)) remaining--;
    }
    return {
      deliveryDate: delivery,
      orderByLocal: cutoff ? `${orderDay} ${cutoff}` : null,
      basis: 'LEAD_TIME',
    };
  }

  return null;
}
