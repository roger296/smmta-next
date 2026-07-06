/**
 * Sales-agent chat state & LLM audit (SPEC §13.6, F5).
 *
 * chat_sessions/chat_messages persist the agent conversation (including tool
 * calls/results for full replay); llm_log records every OpenRouter request +
 * response with tokens/latency/cost. Cost is integer MICRO-USD — the per-day
 * spend cap sums this column (no floats near money). Enum style follows THE
 * SPEC's text-enum.
 */
import { pgTable, uuid, text, integer, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { pk, companyId } from './common.js';
import { storefrontUsers } from './identity.js';

export const chatSessions = pgTable('chat_sessions', {
  id: pk(),
  companyId: companyId(),
  userId: uuid('user_id').references(() => storefrontUsers.id), // nullable: anonymous browsing
  basketId: uuid('basket_id'), // links the agent to the live basket
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

export const chatMessages = pgTable('chat_messages', {
  id: pk(),
  companyId: companyId(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => chatSessions.id),
  role: text('role', { enum: ['user', 'assistant', 'tool'] }).notNull(),
  content: text('content'),
  toolCalls: jsonb('tool_calls'), // session replay shows exactly what the agent looked up
  toolResults: jsonb('tool_results'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const llmLog = pgTable('llm_log', {
  id: pk(),
  companyId: companyId(),
  purpose: text('purpose', { enum: ['chat', 'compose', 'other'] }).notNull(),
  model: text('model').notNull(),
  requestJson: jsonb('request_json').notNull(),
  responseJson: jsonb('response_json'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  latencyMs: integer('latency_ms'),
  costMicroUsd: integer('cost_micro_usd'), // per-day spend cap sums this
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
