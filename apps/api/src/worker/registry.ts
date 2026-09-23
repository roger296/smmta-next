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
  'notify-eta-changed',
  'notify-arrival',
  'cancel-user-drafts',
  'create-shipping-label',
  'create-pick-note',
  'send-dispatch-email',
  'create-supplier-orders',
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
  // Notification agent reactions (§12.4).
  'shipment.eta_changed': ['notify-eta-changed'],
  'shipment.arrived': ['notify-arrival'],
  'consent.revoked': ['cancel-user-drafts'],
  // A paid storefront order gets a shipping label (Smooth Parcel) and a pick
  // note for its warehouse lines, and a supplier order for its drop-ship lines.
  'order.paid': ['create-shipping-label', 'create-pick-note', 'create-supplier-orders'],
  // Every other new order gets a pick note, and a changed order a fresh one.
  'order.created': ['create-pick-note'],
  'order.lines_changed': ['create-pick-note'],
  // A fully allocated order gets a label too, when SHIPPING_LABEL_ON_ALLOCATION
  // is on (the handler checks). A label is never bought twice.
  'order.allocated': ['create-shipping-label'],
  // A released order gets the pick note and label it was refused while held.
  'order.released': ['create-pick-note', 'create-shipping-label'],
  // A shipped order tells the customer, with the courier and tracking number.
  'order.dispatched': ['send-dispatch-email'],
};

/**
 * Reactions added by extensions at start-up (shared/extensions/react.ts):
 * eventType -> their own queue names. Kept apart from EVENT_HANDLERS so the
 * core's routing stays data and an extension's stays the extension's.
 */
const extensionReactions = new Map<string, string[]>();
const EXTENSION_QUEUE = /^[a-z][a-z0-9_]*-[a-z0-9-]{2,60}$/;

export function registerReaction(eventType: DomainEventType, queue: string): void {
  if (!EXTENSION_QUEUE.test(queue)) {
    throw new Error(`Extension queue "${queue}" must be <extension key>-<name>, in lower case`);
  }
  if ((HANDLER_QUEUES as readonly string[]).includes(queue)) throw new Error(`"${queue}" is a core queue`);
  const queues = extensionReactions.get(eventType) ?? [];
  if (!queues.includes(queue)) extensionReactions.set(eventType, [...queues, queue]);
}

/** Every queue an extension has registered, for the worker to create and work. */
export function extensionQueues(): string[] {
  return [...new Set([...extensionReactions.values()].flat())];
}

/** For tests. */
export function clearReactions(): void {
  extensionReactions.clear();
}

export function handlersFor(eventType: string): string[] {
  return [...(EVENT_HANDLERS[eventType as DomainEventType] ?? []), ...(extensionReactions.get(eventType) ?? [])];
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
  { name: 'expired-draft-sweep', cron: '10 * * * *', description: 'Hourly: expire stale drafts (§17.7)' },
  { name: 'google-feed-build', cron: '40 2 * * *', description: 'Nightly: Google Merchant Centre product feeds' },
  { name: 'google-feed-stock-build', cron: '15 * * * *', description: 'Hourly: Merchant Centre price + availability feeds' },
];

// ---- Retry / dead-letter policy (§12.3) ----
// compose-message: 3 retries then dead-letter; send-message: 5 retries.
export const RETRY_POLICY: Record<string, { retryLimit: number; retryDelay: number }> = {
  'compose-message': { retryLimit: 3, retryDelay: 30 },
  'send-message': { retryLimit: 5, retryDelay: 15 },
  // External carrier API: back off long enough for an outage to clear. Safe to
  // retry because the handler is idempotent - a retry never buys a second label.
  'create-shipping-label': { retryLimit: 6, retryDelay: 120 },
  // Local PDF rendering: a failure is rarely transient, so a few quick retries.
  'create-pick-note': { retryLimit: 3, retryDelay: 30 },
  // Hands the email to the storefront's outbox, which is idempotent per order,
  // so a retry after a lost response cannot send the customer two emails.
  'send-dispatch-email': { retryLimit: 5, retryDelay: 60 },
  // Local inserts only, idempotent per (order, supplier); the supplier API is
  // called later by the placer loop, which has its own retry policy.
  'create-supplier-orders': { retryLimit: 5, retryDelay: 30 },
};

export const DEFAULT_RETRY = { retryLimit: 3, retryDelay: 15 } as const;

export function retryPolicyFor(queue: string): { retryLimit: number; retryDelay: number } {
  return RETRY_POLICY[queue] ?? DEFAULT_RETRY;
}

/** Every handler queue routes exhausted jobs to a shared dead-letter queue. */
export const DEAD_LETTER_QUEUE = 'dead-letter';
