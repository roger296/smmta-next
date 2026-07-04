/**
 * Domain-event taxonomy (SPEC §12.2, §12.4, §16.4).
 *
 * Events are past-tense FACTS, never commands. The full union below is the
 * single source of truth for what may be emitted; `emitDomainEvent` and the
 * dispatcher's handler registry are both keyed on it, so a typo in an event
 * name is a compile error.
 */

export const DOMAIN_EVENT_TYPES = [
  // Commerce
  'order.placed',
  'order.paid',
  'order.dispatched',
  'order.cancelled',
  'order.refunded',
  'order.awaiting_payment',
  'order.payment_received',
  'order.payment_overdue',
  'order.lapsed_unpaid',
  'basket.abandoned',
  // Inbound shipments
  'shipment.created',
  'shipment.eta_changed',
  'shipment.arrived',
  'shipment.short_shipped',
  // Stock & pricing
  'stock.replenished',
  'stock.allocation_broken',
  'price.changed',
  // Interest / demand signals
  'interest.flag_created',
  'interest.threshold_crossed',
  'interest.deposit_paid',
  // Customers / consent
  'user.created',
  'user.merged',
  'consent.granted',
  'consent.revoked',
  'suppression.updated',
  // Subscriptions
  'subscription.created',
  'subscription.cancelled',
  'subscription.renewal_upcoming',
  'subscription.payment_failed',
  'subscription.modified',
  // Messaging / agents
  'draft.created',
  'draft.approved',
  'draft.rejected',
  'message.sent',
  'message.failed',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

/** Aggregate the event is about — powers the per-entity event history index. */
export type AggregateType =
  | 'order'
  | 'shipment'
  | 'stock'
  | 'user'
  | 'interest'
  | 'prospective'
  | 'subscription'
  | 'draft'
  | 'consent';

export interface EmitDomainEventInput {
  eventType: DomainEventType;
  aggregateType?: AggregateType;
  aggregateId?: string;
  payload: Record<string, unknown>;
  /** Defaults to the singleton company id. */
  companyId?: string;
}
