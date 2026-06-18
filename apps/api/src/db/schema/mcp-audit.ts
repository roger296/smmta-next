import { pgTable, varchar, jsonb, boolean, text, timestamp, index } from 'drizzle-orm/pg-core';
import { pk, companyId } from './common.js';

// ============================================================
// MCP audit log (spec §A9) — append-only record of every tool call
// ------------------------------------------------------------
// Best-effort: a failed audit write must never fail the tool call.
// ============================================================

export const mcpAuditLog = pgTable(
  'mcp_audit_log',
  {
    id: pk(),
    companyId: companyId(),
    /** First 8 chars of the calling api-key, for attribution. */
    keyPrefix: varchar('key_prefix', { length: 16 }),
    toolName: varchar('tool_name', { length: 80 }).notNull(),
    args: jsonb('args'),
    ok: boolean('ok').notNull().default(true),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    mcpAuditToolIdx: index('mcp_audit_tool_idx').on(t.toolName),
    mcpAuditCreatedIdx: index('mcp_audit_created_idx').on(t.createdAt),
  }),
);
