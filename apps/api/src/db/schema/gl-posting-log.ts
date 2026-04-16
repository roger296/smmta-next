import { pgTable, varchar, decimal, integer, text, jsonb } from 'drizzle-orm/pg-core';
import { pk, companyId, auditTimestamps, glPostingStatusEnum } from './common.js';

/**
 * Local audit table tracking every GL posting sent to Luca.
 * Used for idempotency, retry, and reconciliation.
 */
export const glPostingLog = pgTable('gl_posting_log', {
  id: pk(),
  companyId: companyId(),

  // What triggered this posting
  entityType: varchar('entity_type', { length: 50 }).notNull(),  // e.g. 'INVOICE', 'GRN', 'STOCK_ADJUSTMENT'
  entityId: varchar('entity_id', { length: 100 }).notNull(),     // UUID of the source entity

  // Luca posting details
  lucaTransactionType: varchar('luca_transaction_type', { length: 50 }).notNull(),
  lucaTransactionId: varchar('luca_transaction_id', { length: 100 }),
  idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull().unique(),
  amount: decimal('amount', { precision: 18, scale: 2 }),
  description: text('description'),

  // Status
  status: glPostingStatusEnum('status').notNull().default('PENDING'),
  errorMessage: text('error_message'),
  retryCount: integer('retry_count').notNull().default(0),

  // Full payloads for debugging
  requestPayload: jsonb('request_payload'),
  responsePayload: jsonb('response_payload'),

  ...auditTimestamps,
});
