import {
  pgTable,
  varchar,
  uuid,
  numeric,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { pk, companyId, auditTimestamps } from './common.js';

// ============================================================
// BumbleBee outbound sync log (spec §A8) — idempotency for pushes
// ------------------------------------------------------------
// Auto-Stock pushes per-session materials cost to BumbleBee (P17). The push
// mirrors BumbleBee's idempotency convention: unique on
// (source_system='autostock', source_key=session_id, content_hash). A re-push
// of the same value (same hash) is a no-op; an amended cost (new hash) pushes
// again. `dry_run` records that the BumbleBee endpoint wasn't live (the default
// — only the intended payload was logged, nothing sent).
// ============================================================

export const bumblebeeSyncLog = pgTable(
  'bumblebee_sync_log',
  {
    id: pk(),
    companyId: companyId(),
    sourceSystem: varchar('source_system', { length: 60 }).notNull().default('autostock'),
    /** The session id (the BumbleBee natural key for the cost). */
    sourceKey: varchar('source_key', { length: 200 }).notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    /** What was pushed — e.g. `materials_cost`. */
    kind: varchar('kind', { length: 60 }).notNull().default('materials_cost'),
    /** SUCCESS once recorded (the push or its dry-run completed); FAILED on a
     *  live-post error. */
    status: varchar('status', { length: 20 }).notNull().default('SUCCESS'),
    dryRun: boolean('dry_run').notNull().default(true),
    amount: numeric('amount', { precision: 18, scale: 2 }),
    payload: jsonb('payload'),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    ...auditTimestamps,
  },
  (t) => ({
    bumblebeeSyncUnq: uniqueIndex('bumblebee_sync_source_unq').on(
      t.sourceSystem,
      t.sourceKey,
      t.contentHash,
    ),
  }),
);
