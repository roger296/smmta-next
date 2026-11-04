/**
 * Email system (docs/email/SPEC.md § Data model).
 *
 * Every address the store knows lives in `email_contacts` once, whether or not
 * it belongs to a customer; consent attaches to that row. Two fields are kept
 * apart on purpose: `marketing_status` is what the person agreed to, and
 * `deliverability` is whether the address works. A bounce is not an
 * unsubscribe, but both stop marketing.
 *
 * `marketing_status` only moves through `email_consent_events`: a trigger
 * (migration 0043) refuses an UPDATE that changes it unless a consent event
 * for the same contact and new status was written in the same transaction,
 * so the UI, Claude and the webhooks all leave the same trail. Consent events
 * are append-only.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  bigint,
  doublePrecision,
  index,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { randomBytes } from 'node:crypto';
import { pk, companyId } from './common.js';
import { customers } from './customers.js';
import { storefrontUsers } from './identity.js';

export const emailMarketingStatusEnum = pgEnum('email_marketing_status', [
  'all',
  'transactional_only',
  'never',
]);

export const emailDeliverabilityEnum = pgEnum('email_deliverability', [
  'ok',
  'soft_bounce',
  'hard_bounce',
  'complained',
  'invalid',
]);

/** The four classes of the spec's class table (§ Email classes). SendGrid
 *  categories collapse them to transactional / marketing. */
export const emailClassEnum = pgEnum('email_class', [
  'order_required',
  'requested_service',
  'service',
  'marketing',
]);

export const emailCampaignKindEnum = pgEnum('email_campaign_kind', [
  'weekly_digest',
  'new_product',
  'back_in_stock',
  'manual',
  'automation',
]);

export const emailCampaignStatusEnum = pgEnum('email_campaign_status', [
  'draft',
  'pending_approval',
  'scheduled',
  'sending',
  'paused',
  'sent',
  'cancelled',
]);

export const emailSendStatusEnum = pgEnum('email_send_status', [
  'queued',
  'sent',
  'delivered',
  'deferred',
  'bounced',
  'dropped',
  'opened',
  'clicked',
  'complained',
  'unsubscribed',
]);

export type MarketingStatus = (typeof emailMarketingStatusEnum.enumValues)[number];
export type Deliverability = (typeof emailDeliverabilityEnum.enumValues)[number];
export type EmailClass = (typeof emailClassEnum.enumValues)[number];
export type CampaignKind = (typeof emailCampaignKindEnum.enumValues)[number];
export type CampaignStatus = (typeof emailCampaignStatusEnum.enumValues)[number];
export type SendStatus = (typeof emailSendStatusEnum.enumValues)[number];

/** `{ <interest key>: { score, at } }` — score as of `at`; it halves every
 *  180 days from there (lib/interests.ts). */
export type InterestMap = Record<string, { score: number; at: string }>;

export const emailContacts = pgTable(
  'email_contacts',
  {
    id: pk(),
    companyId: companyId(),
    /** Lower-cased and trimmed; the check constraint refuses anything else. */
    email: varchar('email', { length: 320 }).notNull(),
    customerId: uuid('customer_id').references((): AnyPgColumn => customers.id, { onDelete: 'set null' }),
    storefrontUserId: uuid('storefront_user_id').references(() => storefrontUsers.id, { onDelete: 'set null' }),
    marketingStatus: emailMarketingStatusEnum('marketing_status').notNull().default('transactional_only'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    statusReason: text('status_reason'),
    /** Where consent (or its absence) came from: checkout, signup_form,
     *  sendgrid_import, admin, mcp, backfill, back_in_stock_form, … */
    consentSource: text('consent_source').notNull(),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    /** IP, user agent, form, import id + row + file hash. */
    consentEvidence: jsonb('consent_evidence').$type<Record<string, unknown>>().notNull().default({}),
    deliverability: emailDeliverabilityEnum('deliverability').notNull().default('ok'),
    softBounceCount: integer('soft_bounce_count').notNull().default(0),
    /** Start of the 30-day window soft_bounce_count is counted in. */
    softBounceSince: timestamp('soft_bounce_since', { withTimezone: true }),
    /** deliverable | undeliverable | risky | unknown (Bouncer). */
    bouncerResult: text('bouncer_result'),
    bouncerReason: text('bouncer_reason'),
    bouncerCheckedAt: timestamp('bouncer_checked_at', { withTimezone: true }),
    interests: jsonb('interests').$type<InterestMap>().notNull().default({}),
    isTrade: boolean('is_trade').notNull().default(false),
    /** Preferences page switches (section 2). */
    digestEnabled: boolean('digest_enabled').notNull().default(true),
    newProductAlertsEnabled: boolean('new_product_alerts_enabled').notNull().default(true),
    lastMarketingAt: timestamp('last_marketing_at', { withTimezone: true }),
    lastDigestAt: timestamp('last_digest_at', { withTimezone: true }),
    lastOpenAt: timestamp('last_open_at', { withTimezone: true }),
    lastClickAt: timestamp('last_click_at', { withTimezone: true }),
    lastOrderAt: timestamp('last_order_at', { withTimezone: true }),
    /** UK hour (0–23) this contact most often clicks in; null = campaign default. */
    preferredHour: integer('preferred_hour'),
    /** 32 random bytes, base64url. In every marketing email's unsubscribe link. */
    unsubscribeToken: varchar('unsubscribe_token', { length: 64 })
      .notNull()
      .$defaultFn(() => randomBytes(32).toString('base64url')),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailUnq: uniqueIndex('email_contacts_email_unq').on(t.email),
    tokenUnq: uniqueIndex('email_contacts_unsubscribe_token_unq').on(t.unsubscribeToken),
    customerIdx: index('email_contacts_customer_idx').on(t.customerId),
    statusIdx: index('email_contacts_status_idx').on(t.marketingStatus, t.deliverability),
    emailNormalised: check('email_contacts_email_normalised', sql`${t.email} = lower(btrim(${t.email}))`),
  }),
);

/** Append-only audit of every marketing_status change (trigger in 0043). */
export const emailConsentEvents = pgTable(
  'email_consent_events',
  {
    id: pk(),
    companyId: companyId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => emailContacts.id),
    fromStatus: emailMarketingStatusEnum('from_status'),
    toStatus: emailMarketingStatusEnum('to_status').notNull(),
    /** one_click, link, preferences_page, csv_import, admin_ui, mcp,
     *  complaint_webhook, checkout, signup_form, backfill, … */
    source: text('source').notNull(),
    /** A user id, `claude` or `system`. */
    actor: text('actor').notNull(),
    reason: text('reason'),
    ip: varchar('ip', { length: 64 }),
    userAgent: text('user_agent'),
    evidence: jsonb('evidence').$type<Record<string, unknown>>(),
    /** The writing transaction, which the contacts trigger matches on. */
    txid: bigint('txid', { mode: 'number' })
      .notNull()
      .default(sql`txid_current()`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    contactIdx: index('email_consent_events_contact_idx').on(t.contactId, t.createdAt),
  }),
);

export const emailCampaigns = pgTable(
  'email_campaigns',
  {
    id: pk(),
    companyId: companyId(),
    name: varchar('name', { length: 200 }).notNull(),
    kind: emailCampaignKindEnum('kind').notNull(),
    /** For `automation` campaigns: which automation (replenishment, …). */
    automationKey: varchar('automation_key', { length: 64 }),
    class: emailClassEnum('class').notNull(),
    status: emailCampaignStatusEnum('status').notNull().default('draft'),
    segment: jsonb('segment').$type<Record<string, unknown>>().notNull().default({}),
    audienceCount: integer('audience_count'),
    subject: text('subject').notNull().default(''),
    preheader: text('preheader'),
    templateKey: varchar('template_key', { length: 64 }).notNull().default('manual'),
    /** Ordered blocks the template renders: `[{ type, props }]`. */
    content: jsonb('content').$type<Array<{ type: string; props: Record<string, unknown> }>>().notNull().default([]),
    /** A/B: the B variant row points at A. */
    variantOf: uuid('variant_of').references((): AnyPgColumn => emailCampaigns.id),
    abWinner: varchar('ab_winner', { length: 1 }),
    abDecidedAt: timestamp('ab_decided_at', { withTimezone: true }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    sendWindowMinutes: integer('send_window_minutes').notNull().default(0),
    /** A hero product may override the marketing gap once. */
    overrideGap: boolean('override_gap').notNull().default(false),
    /** Who made it: a user id, `claude` or `system`. */
    createdBy: text('created_by').notNull(),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    utmCampaign: varchar('utm_campaign', { length: 100 }),
    expandedAt: timestamp('expanded_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index('email_campaigns_status_idx').on(t.status, t.scheduledAt),
  }),
);

/** One row per message to one contact. */
export const emailSends = pgTable(
  'email_sends',
  {
    id: pk(),
    companyId: companyId(),
    campaignId: uuid('campaign_id').references(() => emailCampaigns.id),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => emailContacts.id),
    class: emailClassEnum('class').notNull(),
    kind: varchar('kind', { length: 64 }).notNull(),
    templateKey: varchar('template_key', { length: 64 }).notNull(),
    /** What the template renders with (product, order, blocks, …). */
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    /** A/B variant letter, when the campaign has one. */
    variant: varchar('variant', { length: 1 }),
    idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(),
    status: emailSendStatusEnum('status').notNull().default('queued'),
    /** Why a send was dropped: a gate reason, not_in_allowlist, or the
     *  provider's error. */
    dropReason: varchar('drop_reason', { length: 64 }),
    subject: text('subject'),
    sendgridMessageId: varchar('sendgrid_message_id', { length: 200 }),
    /** Not sent before this time (send windows, retry backoff). */
    notBefore: timestamp('not_before', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    firstOpenAt: timestamp('first_open_at', { withTimezone: true }),
    firstClickAt: timestamp('first_click_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idempotencyUnq: uniqueIndex('email_sends_idempotency_key_unq').on(t.idempotencyKey),
    queueIdx: index('email_sends_queue_idx').on(t.status, t.notBefore),
    contactIdx: index('email_sends_contact_idx').on(t.contactId, t.createdAt),
    campaignIdx: index('email_sends_campaign_idx').on(t.campaignId, t.status),
    messageIdx: index('email_sends_sendgrid_message_idx').on(t.sendgridMessageId),
    kindIdx: index('email_sends_kind_queued_idx').on(t.kind, t.queuedAt),
    sentIdx: index('email_sends_sent_at_idx').on(t.sentAt),
  }),
);

/** Raw SendGrid webhook events, kept 13 months. */
export const emailEvents = pgTable(
  'email_events',
  {
    id: pk(),
    companyId: companyId(),
    sendId: uuid('send_id').references(() => emailSends.id, { onDelete: 'set null' }),
    sgEventId: varchar('sg_event_id', { length: 200 }).notNull(),
    event: varchar('event', { length: 40 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sgEventUnq: uniqueIndex('email_events_sg_event_id_unq').on(t.sgEventId),
    sendIdx: index('email_events_send_idx').on(t.sendId),
    receivedIdx: index('email_events_received_idx').on(t.receivedAt),
  }),
);

export const emailTemplates = pgTable(
  'email_templates',
  {
    id: pk(),
    companyId: companyId(),
    key: varchar('key', { length: 64 }).notNull(),
    version: integer('version').notNull().default(1),
    class: emailClassEnum('class').notNull(),
    subjectTemplate: text('subject_template').notNull(),
    /** Identifies the code that renders it (templates/registry.ts) plus any
     *  stored copy an operator has edited. */
    bodySource: text('body_source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyVersionUnq: uniqueIndex('email_templates_key_version_unq').on(t.key, t.version),
  }),
);

export const emailImports = pgTable('email_imports', {
  id: pk(),
  companyId: companyId(),
  filename: text('filename').notNull(),
  /** bounces | spam_reports | unsubscribes | contacts */
  listType: varchar('list_type', { length: 32 }).notNull(),
  defaultStatus: emailMarketingStatusEnum('default_status'),
  defaultInterests: jsonb('default_interests').$type<string[]>().notNull().default([]),
  consentSource: varchar('consent_source', { length: 64 }).notNull(),
  fileSha256: varchar('file_sha256', { length: 64 }).notNull(),
  evidencePath: text('evidence_path'),
  dryRun: boolean('dry_run').notNull(),
  /** A live run names the dry run it was approved from. */
  dryRunId: uuid('dry_run_id').references((): AnyPgColumn => emailImports.id),
  rowCount: integer('row_count').notNull().default(0),
  created: integer('created').notNull().default(0),
  updated: integer('updated').notNull().default(0),
  skipped: integer('skipped').notNull().default(0),
  report: jsonb('report').$type<Record<string, unknown>>().notNull().default({}),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Key-value settings for the email system, seeded with every default. */
export const emailSettings = pgTable('email_settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Token bucket for the sender (one row per bucket; `default` is the only one). */
export const emailRateLimit = pgTable('email_rate_limit', {
  id: varchar('id', { length: 32 }).primaryKey(),
  tokens: doublePrecision('tokens').notNull(),
  refilledAt: timestamp('refilled_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Alerts for the operator: auto-pause, reconciliation problems. Shown on the
 *  admin Deliverability page; the auto-pause also emails the alert address. */
export const emailAlerts = pgTable('email_alerts', {
  id: pk(),
  companyId: companyId(),
  kind: varchar('kind', { length: 64 }).notNull(),
  message: text('message').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  acknowledgedBy: text('acknowledged_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Copy for the weekly digest, per week and per interest key: the featured
 *  paragraph Claude or the operator writes for each material, and the deals
 *  the digest's deals block lists. `key` is an interest key or `all`. */
export const emailWeeklyContent = pgTable(
  'email_weekly_content',
  {
    id: pk(),
    companyId: companyId(),
    /** Monday of the week (UK) the content is for. */
    weekStart: varchar('week_start', { length: 10 }).notNull(),
    key: varchar('key', { length: 80 }).notNull(),
    kind: varchar('kind', { length: 16 }).notNull(), // featured | deal
    title: text('title'),
    body: text('body').notNull(),
    url: text('url'),
    priceGbp: varchar('price_gbp', { length: 16 }),
    savingGbp: varchar('saving_gbp', { length: 16 }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    weekIdx: index('email_weekly_content_week_idx').on(t.weekStart, t.kind),
  }),
);

/** Every MCP tool call and admin action on the email system: who, what
 *  (addresses masked), and the outcome. */
export const emailAudit = pgTable(
  'email_audit',
  {
    id: pk(),
    companyId: companyId(),
    tool: varchar('tool', { length: 80 }).notNull(),
    /** `claude`, `mcp:<key prefix>`, or an admin user id. */
    actor: text('actor').notNull(),
    args: jsonb('args').$type<Record<string, unknown>>(),
    ok: boolean('ok').notNull(),
    summary: text('summary'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdIdx: index('email_audit_created_idx').on(t.createdAt),
  }),
);

/** Baskets the storefront tells us about once it has the shopper's address
 *  (checkout start), for abandoned-basket emails. The storefront owns the
 *  basket itself; this is its last known contents. */
export const emailCarts = pgTable(
  'email_carts',
  {
    id: pk(),
    companyId: companyId(),
    /** The storefront's cart id (opaque here) and which storefront. */
    externalCartId: varchar('external_cart_id', { length: 100 }).notNull(),
    channel: varchar('channel', { length: 64 }).notNull().default('storefront'),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => emailContacts.id),
    lines: jsonb('lines').$type<Array<{ productId: string; quantity: number; priceGbp?: string | null }>>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    orderedAt: timestamp('ordered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    cartUnq: uniqueIndex('email_carts_external_unq').on(t.channel, t.externalCartId),
    contactIdx: index('email_carts_contact_idx').on(t.contactId),
  }),
);

/** Printing tips per material for post-purchase emails. Seeded with short
 *  neutral placeholders that Roger should edit (`needs_review`). */
export const emailMaterialContent = pgTable('email_material_content', {
  key: varchar('key', { length: 80 }).primaryKey(),
  companyId: companyId(),
  markdown: text('markdown').notNull(),
  needsReview: boolean('needs_review').notNull().default(true),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Each product's price as last seen by the price-drop automation. */
export const emailPriceSnapshots = pgTable('email_price_snapshots', {
  productId: uuid('product_id').primaryKey(),
  priceGbp: varchar('price_gbp', { length: 20 }).notNull(),
  seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
});
