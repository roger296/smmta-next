/**
 * The email system's scheduled jobs (pg-boss cron). Times are UK local time
 * (`tz`), so a 10:00 digest stays at 10:00 across the clock change. Names use
 * hyphens like the rest of the worker's queues (the runbook writes them as
 * `email.<name>`).
 */
import type { ScheduledJob } from '../../../worker/registry.js';

export const EMAIL_SCHEDULED_JOBS: ScheduledJob[] = [
  { name: 'email-send', cron: '* * * * *', description: 'Every minute: send due email_sends rows within the rate limit' },
  { name: 'email-bis-recheck', cron: '55 8 * * *', tz: 'Europe/London', description: 'Daily 08:55 UK: send back-in-stock requests that are due (roll-ups go at 09:00)' },
  { name: 'email-close-stale-bis', cron: '35 3 * * *', tz: 'Europe/London', description: 'Nightly: close back-in-stock requests older than 180 days' },
];
