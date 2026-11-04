/**
 * canSend — the one gate every email passes (spec § Email classes and consent
 * rules). The class table below IS the policy; the function only applies it.
 *
 *                     | all | transactional_only | never | hard bounce / complained / invalid
 *   order_required    | yes | yes                | yes   | yes (one attempt; the order needs it)
 *   requested_service | yes | yes                | no    | no
 *   service           | yes | yes                | no    | no
 *   marketing         | yes | no                 | no    | no
 *
 * Marketing has further gates, all from settings: the kill switch, the minimum
 * gap and the 24-hour floor, the UK send window, the unengaged cadence, and the
 * per-contact digest / new-product switches. A soft-bouncing address with too
 * many recent soft bounces counts as hard-bounced.
 */
import type { Deliverability, EmailClass, MarketingStatus } from '../../../db/schema/email.js';
import type { EmailSettings } from './settings-defaults.js';

export const GATE_REASONS = [
  'never',
  'transactional_only',
  'hard_bounce',
  'complained',
  'invalid',
  'soft_bounce_limit',
  'gap',
  'window',
  'unengaged',
  'paused',
  'allowlist',
  'digest_disabled',
  'new_product_disabled',
] as const;
export type GateReason = (typeof GATE_REASONS)[number];

export type GateResult = { ok: true } | { ok: false; reason: GateReason };

interface ClassPolicy {
  statuses: readonly MarketingStatus[];
  /** Whether a hard-bounced / complained / invalid address may still be sent to. */
  badAddressAllowed: boolean;
}

export const CLASS_POLICY: Record<EmailClass, ClassPolicy> = {
  order_required: { statuses: ['all', 'transactional_only', 'never'], badAddressAllowed: true },
  requested_service: { statuses: ['all', 'transactional_only'], badAddressAllowed: false },
  service: { statuses: ['all', 'transactional_only'], badAddressAllowed: false },
  marketing: { statuses: ['all'], badAddressAllowed: false },
};

/** The fields of a contact the gate reads. */
export interface GateContact {
  marketingStatus: MarketingStatus;
  deliverability: Deliverability;
  softBounceCount: number;
  softBounceSince: Date | null;
  lastMarketingAt: Date | null;
  digestEnabled: boolean;
  newProductAlertsEnabled: boolean;
}

export interface GateInput {
  class: EmailClass;
  kind: string;
  now: Date;
  settings: Pick<
    EmailSettings,
    | 'marketing_paused'
    | 'marketing_min_gap_days'
    | 'marketing_floor_hours'
    | 'send_window'
    | 'unengaged_limit'
    | 'unengaged_cadence_days'
    | 'soft_bounce_limit'
    | 'soft_bounce_window_days'
  >;
  /** Marketing sends in a row, most recent first, with neither a click nor
   *  an order after them. Opens do not count (Apple Mail Privacy Protection
   *  opens every message). Supplied by the caller; 0 when unknown. */
  unengagedStreak?: number;
  /** A hero product's campaign may skip the minimum gap (not the floor). */
  overrideGap?: boolean;
  /** The send window applies when it is set; the sender sets it, a campaign
   *  being planned for later does not. */
  checkWindow?: boolean;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function canSend(contact: GateContact, input: GateInput): GateResult {
  const policy = CLASS_POLICY[input.class];
  const { settings, now } = input;

  if (!policy.statuses.includes(contact.marketingStatus)) {
    return { ok: false, reason: contact.marketingStatus === 'never' ? 'never' : 'transactional_only' };
  }

  if (!policy.badAddressAllowed) {
    const bad = badAddressReason(contact, now, settings);
    if (bad) return { ok: false, reason: bad };
  }

  if (input.class !== 'marketing') return { ok: true };

  if (settings.marketing_paused) return { ok: false, reason: 'paused' };
  if (input.kind === 'weekly_digest' && !contact.digestEnabled) return { ok: false, reason: 'digest_disabled' };
  if (input.kind === 'new_product' && !contact.newProductAlertsEnabled) {
    return { ok: false, reason: 'new_product_disabled' };
  }

  if (contact.lastMarketingAt) {
    const since = now.getTime() - contact.lastMarketingAt.getTime();
    if (since < settings.marketing_floor_hours * HOUR_MS) return { ok: false, reason: 'gap' };
    if (!input.overrideGap && since < settings.marketing_min_gap_days * DAY_MS) return { ok: false, reason: 'gap' };
    if (
      (input.unengagedStreak ?? 0) >= settings.unengaged_limit &&
      since < settings.unengaged_cadence_days * DAY_MS
    ) {
      return { ok: false, reason: 'unengaged' };
    }
  }

  if (input.checkWindow && !inSendWindow(now, settings.send_window)) return { ok: false, reason: 'window' };

  return { ok: true };
}

function badAddressReason(
  contact: GateContact,
  now: Date,
  settings: GateInput['settings'],
): GateReason | null {
  switch (contact.deliverability) {
    case 'hard_bounce':
      return 'hard_bounce';
    case 'complained':
      return 'complained';
    case 'invalid':
      return 'invalid';
    case 'soft_bounce':
      if (
        contact.softBounceCount >= settings.soft_bounce_limit &&
        contact.softBounceSince &&
        now.getTime() - contact.softBounceSince.getTime() <= settings.soft_bounce_window_days * DAY_MS
      ) {
        return 'soft_bounce_limit';
      }
      return null;
    default:
      return null;
  }
}

/** Minutes past midnight in the window's time zone. */
export function localMinutes(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

function hhmm(s: string): number {
  const [h = '0', m = '0'] = s.split(':');
  return Number(h) * 60 + Number(m);
}

export function inSendWindow(now: Date, window: { start: string; end: string; timezone: string }): boolean {
  const t = localMinutes(now, window.timezone);
  return t >= hhmm(window.start) && t < hhmm(window.end);
}

/** The next moment at or after `now` that is inside the window. */
export function nextWindowOpening(now: Date, window: { start: string; end: string; timezone: string }): Date {
  if (inSendWindow(now, window)) return now;
  // Step forward a minute at a time from the next whole minute; at most a day.
  const start = new Date(Math.ceil(now.getTime() / 60_000) * 60_000);
  for (let i = 0; i <= 24 * 60; i++) {
    const t = new Date(start.getTime() + i * 60_000);
    if (inSendWindow(t, window)) return t;
  }
  return now;
}

/** SendGrid's two-way split of the four classes. */
export function broadCategory(cls: EmailClass): 'transactional' | 'marketing' {
  return cls === 'marketing' ? 'marketing' : 'transactional';
}
