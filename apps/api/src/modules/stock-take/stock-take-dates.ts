/**
 * Stock-take dates on the venue's calendar (Europe/London), shared by the
 * results page, its downloads and the report script. A count opened at 23:30
 * UTC on 30 Sept in summer was opened on 1 Oct at the venue — and that is the
 * day a manager asking for "October's counts" means.
 */
const LONDON = 'Europe/London';

/** YYYY-MM-DD of a moment, on the London calendar. */
export function londonDay(d: Date | string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: LONDON,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(d));
}

/** "30/09/2026 15:47", London time — no comma, so a CSV cell needs no quotes. */
export function londonStamp(d: Date | string | null | undefined): string {
  if (!d) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: LONDON,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(d))
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** In range if opened OR approved on a London day in [from, to], inclusive. */
export function inRange(
  take: { createdAt: Date | string; approvedAt: Date | string | null },
  from: string,
  to: string,
): boolean {
  const days = [londonDay(take.createdAt), take.approvedAt ? londonDay(take.approvedAt) : null];
  return days.some((d) => d !== null && d >= from && d <= to);
}
