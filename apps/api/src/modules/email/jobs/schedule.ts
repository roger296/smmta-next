/**
 * The email system's scheduled jobs (pg-boss cron). Times are UK local time
 * (`tz`), so a 10:00 digest stays at 10:00 across the clock change. Names use
 * hyphens like the rest of the worker's queues (the runbook writes them as
 * `email.<name>`).
 */
import type { ScheduledJob } from '../../../worker/registry.js';

export const EMAIL_SCHEDULED_JOBS: ScheduledJob[] = [
  { name: 'email-send', cron: '* * * * *', description: 'Every minute: send due email_sends rows within the rate limit' },
  { name: 'email-campaigns-tick', cron: '* * * * *', description: 'Every minute: expand due campaigns into sends; close finished ones' },
  { name: 'email-digest-draft', cron: '*/15 * * * *', description: "Every 15 min: on the digest's draft day, after its draft time, create the week's digest (once)" },
  { name: 'email-new-product-rollup', cron: '*/15 * * * *', description: 'Every 15 min: after the roll-up time, one new-product alert campaign for the day (once)' },
  { name: 'email-bis-recheck', cron: '55 8 * * *', tz: 'Europe/London', description: 'Daily 08:55 UK: send back-in-stock requests that are due (roll-ups go at 09:00)' },
  { name: 'email-verify-retry', cron: '20 4 * * *', tz: 'Europe/London', description: 'Daily: re-check addresses Bouncer called unknown 24+ hours ago' },
  { name: 'email-reconcile-suppressions', cron: '15 2 * * *', tz: 'Europe/London', description: 'Nightly: apply SendGrid suppressions the webhook missed' },
  { name: 'email-deliverability-check', cron: '45 6 * * *', tz: 'Europe/London', description: 'Daily: 7-day bounce/complaint rates; pause marketing over the limits' },
  { name: 'email-decay-interests', cron: '5 3 * * *', tz: 'Europe/London', description: 'Nightly: decay interest scores (half-life 180 days)' },
  { name: 'email-prune-events', cron: '40 4 * * 0', tz: 'Europe/London', description: 'Weekly: delete webhook events older than 13 months' },
  { name: 'email-close-stale-bis', cron: '35 3 * * *', tz: 'Europe/London', description: 'Nightly: close back-in-stock requests older than 180 days' },
];
