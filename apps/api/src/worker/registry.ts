/**
 * Job registry (SPEC §12.3, §12.4).
 *
 * Three things live here, all data:
 *  - HANDLER_QUEUES: every event-driven handler queue name.
 *  - EVENT_HANDLERS: the typed fan-out map (eventType → handler queue names)
 *    the dispatcher reads. Adding a reaction is a one-line edit here — the
 *    commerce code that emits the event never changes (§12.1).
 *  - SCHEDULED_JOBS: the pg-boss cron catalogue.
 *
 * In Prompt 1 the handlers themselves are no-op stubs (see handlers.ts); later
 * prompts replace each stub with the real implementation. The wiring is real
 * now so the outbox path is exercised end-to-end.
 */
import type { DomainEventType } from '../shared/events/types.js';

// ---- Event-driven handler queues (§12.3 "Event-driven handlers") ----
export const HANDLER_QUEUES = [
  'compose-message',
  'send-message',
  'back-in-stock-fanout',
  'threshold-check',
  'identity-merge',
] as const;

export type HandlerQueue = (typeof HANDLER_QUEUES)[number];

/**
 * eventType → handler queue names. Only the mappings whose handlers exist as
 * stubs in Prompt 1 are wired; the reaction map (§12.4) that routes many event
 * types into `compose-message` is filled in from Prompt 9/11 onward.
 */
export const EVENT_HANDLERS: Partial<Record<DomainEventType, HandlerQueue[]>> = {
  'stock.replenished': ['back-in-stock-fanout'],
  'interest.flag_created': ['threshold-check'],
  'user.created': ['identity-merge'],
  // An approved (or auto-approved) draft goes straight to the send-time gate.
  'draft.approved': ['send-message'],
};

export function handlersFor(eventType: string): HandlerQueue[] {
  return EVENT_HANDLERS[eventType as DomainEventType] ?? [];
}

// ---- Scheduled scanners (§12.3, pg-boss cron) ----
// `outbox-dispatcher` is intentionally NOT here: it runs on a ~10s setInterval
// loop in startWorker (pg-boss cron granularity is 1 minute), per §12.3.
export interface ScheduledJob {
  name: string;
  cron: string;
  description: string;
}

export const SCHEDULED_JOBS: ScheduledJob[] = [
  { name: 'eta-watch', cron: '0 6 * * *', description: 'Daily: shipment ETAs vs order promises → F6' },
  { name: 'stock-watch', cron: '0 * * * *', description: 'Hourly: allocation shortfalls + back-in-stock transitions' },
  { name: 'run-out-prediction', cron: '30 2 * * *', description: 'Nightly: per-customer consumable cadence (F7)' },
  { name: 'marketing-nightly', cron: '0 3 * * *', description: 'Nightly: segmentation SQL → compose-message' },
  { name: 'basket-abandonment-scan', cron: '20 * * * *', description: 'Hourly: stale baskets → basket.abandoned' },
  { name: 'subscription-renewal-scan', cron: '0 5 * * *', description: 'Daily: due renewals → mandate charges + reminders' },
  { name: 'payment-window-scan', cron: '0 4 * * *', description: 'Daily: manual-transfer overdue/lapse (§16.4)' },
  { name: 'agent-digest', cron: '0 7 * * *', description: 'Daily 07:00: owner digest email' },
];

// ---- Retry / dead-letter policy (§12.3) ----
// compose-message: 3 retries then dead-letter; send-message: 5 retries.
export const RETRY_POLICY: Record<string, { retryLimit: number; retryDelay: number }> = {
  'compose-message': { retryLimit: 3, retryDelay: 30 },
  'send-message': { retryLimit: 5, retryDelay: 15 },
};

export const DEFAULT_RETRY = { retryLimit: 3, retryDelay: 15 } as const;

export function retryPolicyFor(queue: string): { retryLimit: number; retryDelay: number } {
  return RETRY_POLICY[queue] ?? DEFAULT_RETRY;
}

/** Every handler queue routes exhausted jobs to a shared dead-letter queue. */
export const DEAD_LETTER_QUEUE = 'dead-letter';
