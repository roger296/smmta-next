/**
 * Plain-English summaries of a supplier's account at a venue, for the
 * "Venues & delivery" tab. Pure, so the wording is tested once.
 */
import type { SiteAccount, SiteAccountView } from './use-site-accounts';

const DAY_NAMES: Record<string, string> = {
  MON: 'Mon', TUE: 'Tue', WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun',
};
const ORDER = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

/** "Tue, Thu" / "1 working day" / "Not set". */
export function describeDeliveries(a: SiteAccount): string {
  if (a.deliveryDays.length > 0) {
    return [...a.deliveryDays].sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y)).map((d) => DAY_NAMES[d] ?? d).join(', ');
  }
  if (a.leadDays != null) return a.leadDays === 1 ? '1 working day' : `${a.leadDays} working days`;
  return 'Not set';
}

/** "16:00, the day before" / "12:00 on the day" / "—". */
export function describeCutoff(a: SiteAccount): string {
  if (!a.cutoffTime) return '—';
  const t = a.cutoffTime.slice(0, 5);
  if (a.deliveryDays.length === 0) return `${t} for that day's order`;
  if (a.cutoffDaysBefore === 0) return `${t} on the day`;
  if (a.cutoffDaysBefore === 1) return `${t}, the day before`;
  return `${t}, ${a.cutoffDaysBefore} days before`;
}

const longDate = (iso: string): string =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** "Thu 1 Oct — order by Wed 30 Sept 16:00", or why there is no date. */
export function describeNextDelivery(v: SiteAccountView): string {
  if (!v.account) return 'No account';
  if (!v.account.isActive) return 'Switched off';
  if (!v.nextDelivery) return 'Add delivery days or a lead time';
  const { deliveryDate, orderByLocal } = v.nextDelivery;
  if (!orderByLocal) return longDate(deliveryDate);
  const [d, t] = orderByLocal.split(' ');
  return `${longDate(deliveryDate)} — order by ${longDate(d!)} ${t}`;
}

export const pounds = (v: string | null): string => (v == null ? '—' : `£${Number(v).toFixed(2)}`);
