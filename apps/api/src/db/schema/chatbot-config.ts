/**
 * Chatbot configuration — the rows that make one deployment's assistant
 * different from another's.
 *
 * The pipeline code (classifier → specialist → grounding filter) is
 * deliberately domain-neutral: nothing in it mentions filament, spools,
 * or PETG. Everything store-specific lives here, so standing the same
 * bot up on the clothing storefront is a seed script rather than a fork.
 *
 * `chatbot_config` is a SINGLETON — one Coolify deploy is one store, so
 * one row is exact and reads never need a tenancy predicate. The
 * companyId column is carried for consistency with the rest of the
 * schema and for the (unlikely) future where a deploy serves two brands.
 *
 * `specialist_prompts` holds one row per category; the category slugs
 * are code-defined and stable because the tool sets are, while the
 * prompt bodies are admin-editable. `prompt_versions` is append-only
 * history so an edit can be rolled back and so a chat turn can be
 * attributed to the exact prompt text that produced it.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { pk, companyId } from './common.js';
import { users } from './auth.js';
import { chatSessions } from './chat.js';

/**
 * The six specialist categories plus the two non-specialist outcomes.
 * Kept as a plain const (not a pgEnum) because adding a category is a
 * code change that ships new tools — a DB enum migration would add
 * ceremony without adding safety.
 */
export const CHAT_CATEGORIES = [
  'pre_sales',
  'order_status',
  'delivery_returns',
  'product_advice',
  'commercial_offer',
  'complaint',
] as const;
export type ChatCategory = (typeof CHAT_CATEGORIES)[number];

/** Classifier outcomes that don't route to a specialist. */
export const CHAT_NON_SPECIALIST_OUTCOMES = ['ambiguous', 'irrelevant'] as const;
export type ChatClassifierOutcome = ChatCategory | (typeof CHAT_NON_SPECIALIST_OUTCOMES)[number];

export const chatbotConfig = pgTable('chatbot_config', {
  id: pk(),
  companyId: companyId(),
  /** Interpolated into prompts as {{store_name}}. */
  storeName: text('store_name').notNull(),
  /** Interpolated into prompts as {{product_kind}}. What this store
   *  sells, in the words a customer would use: "3D printer filament",
   *  "workwear and branded clothing". Drives what the classifier
   *  considers on-topic. */
  productKind: text('product_kind').notNull(),
  /** System prompt for the stage-1 classifier. Supports the same
   *  {{store_name}} / {{product_kind}} placeholders. */
  classifierPrompt: text('classifier_prompt').notNull(),
  /** Verbatim copy returned when the classifier says `irrelevant`.
   *  Never LLM-authored at runtime — a jailbreak that convinces the
   *  classifier a message is off-topic must not also get to write the
   *  refusal in the attacker's voice. */
  offtopicRefusal: text('offtopic_refusal').notNull(),
  /** Where escalate_to_human notifications are sent. */
  escalationEmail: text('escalation_email').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const specialistPrompts = pgTable('specialist_prompts', {
  id: pk(),
  companyId: companyId(),
  /** One of CHAT_CATEGORIES. Unique per company. */
  category: text('category').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  /** Optional per-category model override; null = pipeline default. */
  modelOverride: text('model_override'),
  /** A disabled specialist routes to escalate instead of answering —
   *  lets a store launch before its knowledge base is ready. */
  enabled: boolean('enabled').notNull().default(true),
  /** Bumped on every save. chat_classifications records which version
   *  answered, so prompt revisions can be compared on real traffic. */
  version: integer('version').notNull().default(1),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Unique so the first-boot seeder can't double-insert a category if
  // two requests race to seed an empty table.
  categoryIdx: uniqueIndex('specialist_prompts_category_idx').on(t.companyId, t.category),
}));

export const promptVersions = pgTable('prompt_versions', {
  id: pk(),
  companyId: companyId(),
  /** 'classifier' | 'specialist:<category>' — a single history table
   *  for both prompt kinds keeps the admin rollback UI uniform. */
  target: text('target').notNull(),
  version: integer('version').notNull(),
  body: text('body').notNull(),
  savedBy: uuid('saved_by').references(() => users.id),
  savedAt: timestamp('saved_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  targetIdx: index('prompt_versions_target_idx').on(t.companyId, t.target, t.version),
}));

/**
 * One row per classified user turn. The audit + tuning table: which
 * category was chosen, how confident, which prompt version decided it,
 * and what it cost. `llm_log` already records the raw request/response
 * for every model call, so nothing is duplicated here.
 */
export const chatClassifications = pgTable('chat_classifications', {
  id: pk(),
  companyId: companyId(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => chatSessions.id),
  turnOrdinal: integer('turn_ordinal').notNull(),
  category: text('category').notNull(),
  confidence: text('confidence', { enum: ['high', 'medium', 'low'] }).notNull(),
  /** specialist_prompts.version / prompt_versions.version in force. */
  classifierVersion: integer('classifier_version'),
  latencyMs: integer('latency_ms'),
  costMicroUsd: integer('cost_micro_usd'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sessionIdx: index('chat_classifications_session_idx').on(t.sessionId),
  categoryIdx: index('chat_classifications_category_idx').on(t.companyId, t.category, t.createdAt),
}));
