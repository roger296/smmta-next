/**
 * Domain events — the outbox table (SPEC §13.5, §4.3).
 *
 * The API writes an event row in the SAME transaction as the business change
 * (via `emitDomainEvent`, see `shared/events/emit.ts`). The worker's
 * `outbox-dispatcher` polls unprocessed rows and fans each out to typed
 * handler jobs, then stamps `processed_at`.
 *
 * Adaptation vs THE SPEC (logged in BUILD_LOG): repo convention puts a
 * `company_id` on every table, so this table carries one too (single-tenant
 * singleton). Everything else matches §13.5 — the partial index on
 * unprocessed rows keeps the dispatcher poll O(pending), and the aggregate
 * pointers give a per-entity event history for support/debugging.
 */
import { pgTable, uuid, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { pk, companyId } from './common.js';

export const domainEvents = pgTable(
  'domain_events',
  {
    id: pk(),
    companyId: companyId(),
    // e.g. 'shipment.eta_changed' (§12.2). Kept as free text (not a pg enum)
    // so adding an event type never needs a migration.
    eventType: text('event_type').notNull(),
    aggregateType: text('aggregate_type'), // 'order' | 'shipment' | 'user' | ...
    aggregateId: uuid('aggregate_id'), // → per-entity event history
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }), // set by dispatcher
  },
  (t) => ({
    eventsUnprocessedIdx: index('ix_events_unprocessed')
      .on(t.createdAt)
      .where(sql`processed_at IS NULL`),
    eventsAggregateIdx: index('ix_events_aggregate').on(t.aggregateType, t.aggregateId),
  }),
);
