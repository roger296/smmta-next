/**
 * Every email setting and its default (Part B; spec § Admin UI → Settings).
 * The values live in `email_settings`; a key with no row reads as its default
 * here, and the settings service writes the defaults on first read so the
 * table always shows the whole set.
 */
export const EMAIL_SETTING_DEFAULTS = {
  /** Sends per hour across the whole system (token bucket, refilled per minute). */
  rate_limit_per_hour: 600,
  /** At most one marketing email per contact per N days. */
  marketing_min_gap_days: 7,
  /** Never two marketing emails within this many hours, whatever the gap. */
  marketing_floor_hours: 24,
  /** Claude-made marketing to more contacts than this waits for a person. */
  approval_threshold: 50,
  /** Marketing goes out between these UK times only. */
  send_window: { start: '08:00', end: '20:00', timezone: 'Europe/London' },
  /** Kill switch for every marketing send. */
  marketing_paused: false,
  /** Why it was paused, and by whom (auto-pause writes this). */
  marketing_paused_reason: '',
  /** Unopened-and-unclicked marketing in a row before the quarterly cadence. */
  unengaged_limit: 6,
  unengaged_cadence_days: 90,
  /** Soft bounces in the window before the address counts as hard-bounced. */
  soft_bounce_limit: 3,
  soft_bounce_window_days: 30,
  digest: {
    draft_day: 3, // Wednesday (0 = Sunday)
    draft_time: '10:00',
    send_day: 4, // Thursday
    send_time: '10:00',
    window_minutes: 180,
  },
  new_product_rollup_time: '11:00',
  /** Skip a new-product alert when the contact's digest is due this soon. */
  digest_due_skip_hours: 48,
  auto_pause: { complaint_rate: 0.002, bounce_rate: 0.03, min_sends: 200, days: 7 },
  interest_decay: { half_life_days: 180, order_points: 10, click_points: 2, interested_threshold: 3 },
  /** Days a 1 kg spool lasts, by material key; multiplied by quantity. */
  replenishment_days: {
    'material:pla': 42,
    'material:petg': 49,
    'material:abs': 56,
    'material:asa': 56,
    'material:tpu': 70,
    'material:nylon': 70,
    'material:carbon': 56,
    default: 49,
  } as Record<string, number>,
  bouncer_cache_days: 90,
  event_retention_months: 13,
  attribution_window_days: 5,
  ab_test: { share: 0.2, decide_after_hours: 2, min_audience: 200 },
  /** Shown in the From header; the address itself is EMAIL_FROM_ADDRESS. */
  from_name: 'CleverDeals',
  reply_to: 'sales@cleverdeals.net',
} as const;

export type EmailSettings = {
  -readonly [K in keyof typeof EMAIL_SETTING_DEFAULTS]: (typeof EMAIL_SETTING_DEFAULTS)[K] extends number
    ? number
    : (typeof EMAIL_SETTING_DEFAULTS)[K] extends boolean
      ? boolean
      : (typeof EMAIL_SETTING_DEFAULTS)[K] extends string
        ? string
        : (typeof EMAIL_SETTING_DEFAULTS)[K];
};

export type EmailSettingKey = keyof EmailSettings;

export function defaultSettings(): EmailSettings {
  return structuredClone(EMAIL_SETTING_DEFAULTS) as unknown as EmailSettings;
}
