/**
 * The `email_` MCP tools (spec § MCP interface; runbook section 10). Each tool
 * is plain data — name, description, input schema, handler — so the MCP
 * server registers them and tests can call them through a real MCP client.
 *
 * Guard rails, as the descriptions tell Claude:
 *  - Claude can draft, preview and schedule freely. A marketing campaign
 *    Claude schedules for more than `approval_threshold` contacts (50) goes to
 *    `pending_approval` and waits for a person.
 *  - Approval needs a person: `email_approve_campaign` only works for an MCP
 *    key carrying the `email:approve` scope (Roger's); otherwise use the admin.
 *  - Test sends go only to EMAIL_TEST_ALLOWLIST.
 *  - `never` and any upgrade to `all` need `confirm: true` and a reason.
 *  - Imports are dry runs unless given the id of a dry run of the same file.
 *  - Every call is written to `email_audit` with addresses masked.
 */
import { resolve } from 'node:path';
import { z } from 'zod';
import { previewSegment, segmentSchema } from '../services/audience.service.js';
import { AbService } from '../services/ab.service.js';
import { CampaignsService } from '../services/campaigns.service.js';
import { ContactsService } from '../services/contacts.service.js';
import { ImportsService, LIST_TYPES, saveUploadedCsv } from '../services/imports.service.js';
import { contactFilterSchema, OperatorService } from '../services/operator.service.js';
import { ReportsService } from '../services/reports.service.js';
import { getEmailSettings, updateEmailSettings } from '../services/settings.service.js';
import { renderForSamples } from '../templates/render.js';
import { TEMPLATE_KEYS } from '../templates/registry.js';
import { BLOCK_TYPES, type Block } from '../templates/blocks.js';
import { DigestService } from '../services/digest.service.js';
import type { Contact } from '../services/contacts.service.js';

export interface ToolContext {
  /** `claude`, or `mcp:<key prefix>` for a key allowed to approve. */
  actor: string;
  canApprove: boolean;
}

export interface EmailTool {
  name: string;
  description: string;
  input: z.ZodRawShape;
  handler: (args: any, ctx: ToolContext) => Promise<unknown>;
}

const blockSchema = z.object({ type: z.enum(BLOCK_TYPES as [string, ...string[]]), props: z.record(z.unknown()) });
const operator = () => new OperatorService();
const campaigns = () => new CampaignsService();

const campaignShape = {
  name: z.string().min(1).describe('Internal name'),
  kind: z.enum(['manual', 'weekly_digest', 'new_product', 'automation']).default('manual'),
  class: z.enum(['marketing', 'service', 'requested_service']).default('marketing'),
  segment: segmentSchema.default({}).describe('Who: {status, interests_any, interests_all, is_trade, last_order_within_days, last_order_older_than_days, engaged_within_days, source, exclude_campaign_ids, contact_ids}'),
  subject: z.string().default(''),
  preheader: z.string().optional(),
  template_key: z.enum(TEMPLATE_KEYS as [string, ...string[]]).default('manual'),
  content: z.array(blockSchema).default([]).describe(`Ordered blocks: ${BLOCK_TYPES.join(', ')}`),
  scheduled_at: z.string().datetime().optional().describe('ISO time; default: when scheduled'),
  send_window_minutes: z.number().int().min(0).max(1440).default(0),
  subject_b: z.string().optional().describe('A/B: a second subject line (audience ≥ 200 splits 10%/10%, winner by clicks after 2 hours)'),
};

export const EMAIL_TOOLS: EmailTool[] = [
  {
    name: 'email_list_contacts',
    description: 'List email contacts, filtered by status, deliverability, interest key, engagement, trade, last order or source. Paged. Read only.',
    input: contactFilterSchema.shape,
    handler: (a) => operator().listContacts(a),
  },
  {
    name: 'email_get_contact',
    description: "One contact: consent history, the last 50 sends with their events, interest scores, orders summary. Read only. Give the contact's id or address.",
    input: { id: z.string().uuid().optional(), email: z.string().optional() },
    handler: async (a) => {
      const id = a.id ?? (a.email ? (await new ContactsService().getByEmail(a.email))?.id : undefined);
      if (!id) throw new Error('contact not found');
      const c = await operator().getContact(id);
      if (!c) throw new Error('contact not found');
      return c;
    },
  },
  {
    name: 'email_set_marketing_status',
    description:
      'Change a contact\'s marketing status (all | transactional_only | never) with a reason. Setting never, or any upgrade to all, needs confirm: true. A downgrade always works. Logged as a consent event.',
    input: {
      contact_id: z.string().uuid(),
      status: z.enum(['all', 'transactional_only', 'never']),
      reason: z.string().min(3),
      confirm: z.boolean().default(false),
    },
    handler: (a, ctx) =>
      new ContactsService().setMarketingStatus(a.contact_id, a.status, { source: 'mcp', actor: ctx.actor, reason: a.reason, confirm: a.confirm }),
  },
  {
    name: 'email_import_csv',
    description:
      'Import a contact list (bounces, spam_reports, unsubscribes or contacts). dry_run defaults to true and returns the report; a live run needs dry_run_id from a dry run of the same file. Give the CSV as text, or a file_path under imports/. Run bounces → spam_reports → unsubscribes → contacts. Imports never upgrade consent.',
    input: {
      list_type: z.enum(LIST_TYPES),
      csv: z.string().optional(),
      file_path: z.string().optional(),
      filename: z.string().optional(),
      dry_run: z.boolean().default(true),
      dry_run_id: z.string().uuid().optional(),
      default_interests: z.array(z.string()).optional(),
      consent_source: z.string().optional(),
    },
    handler: async (a, ctx) => {
      let path: string;
      if (a.csv) {
        path = await saveUploadedCsv(a.csv);
      } else if (a.file_path) {
        const root = resolve(process.cwd(), '../../imports');
        path = resolve(root, a.file_path.replace(/^imports\//, ''));
        if (!path.startsWith(root)) throw new Error('file_path must be inside imports/');
      } else throw new Error('give csv or file_path');
      return new ImportsService().run({
        filePath: path,
        filename: a.filename ?? (a.file_path ? a.file_path.split('/').pop() : 'mcp-upload.csv'),
        listType: a.list_type,
        dryRun: a.dry_run,
        dryRunId: a.dry_run_id,
        defaultInterests: a.default_interests,
        consentSource: a.consent_source ?? 'mcp',
        actor: ctx.actor,
      });
    },
  },
  {
    name: 'email_get_import',
    description: 'An import\'s report and conflicts, or the latest imports when no id is given. Read only.',
    input: { id: z.string().uuid().optional() },
    handler: async (a) => (a.id ? new ImportsService().get(a.id) : new ImportsService().list(20)),
  },
  {
    name: 'email_preview_segment',
    description: 'How many contacts a segment reaches after the gate (consent, deliverability, marketing gap, pause), with 10 masked samples. Read only.',
    input: { segment: segmentSchema.default({}), class: z.enum(['marketing', 'service', 'requested_service']).default('marketing'), kind: z.string().default('manual') },
    handler: (a) => previewSegment(a.segment, { class: a.class, kind: a.kind }),
  },
  {
    name: 'email_create_campaign',
    description: 'Create a campaign. It always stays a draft until email_schedule_campaign. Optional subject_b makes it an A/B test.',
    input: campaignShape,
    handler: async (a, ctx) => {
      const c = await campaigns().create(
        {
          name: a.name,
          kind: a.kind,
          class: a.class,
          segment: a.segment,
          subject: a.subject,
          preheader: a.preheader,
          templateKey: a.template_key,
          content: a.content as Block[],
          scheduledAt: a.scheduled_at ? new Date(a.scheduled_at) : null,
          sendWindowMinutes: a.send_window_minutes,
        },
        ctx.actor,
      );
      if (a.subject_b) await new AbService().createVariant(c.id, a.subject_b, ctx.actor);
      return c;
    },
  },
  {
    name: 'email_update_campaign',
    description: 'Edit a draft, pending or scheduled campaign (it goes back to draft). Read the campaign first with email_get_campaign_report.',
    input: { id: z.string().uuid(), ...Object.fromEntries(Object.entries(campaignShape).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])) },
    handler: (a) =>
      campaigns().update(a.id, {
        name: a.name,
        segment: a.segment,
        subject: a.subject,
        preheader: a.preheader,
        templateKey: a.template_key,
        content: a.content,
        scheduledAt: a.scheduled_at ? new Date(a.scheduled_at) : undefined,
        sendWindowMinutes: a.send_window_minutes,
      }),
  },
  {
    name: 'email_render_preview',
    description: 'The campaign rendered (subject, HTML, text) as three real contacts would see it: one with interests, one trade, one new. Read only.',
    input: { id: z.string().uuid(), html: z.boolean().default(false).describe('Include the HTML (large)') },
    handler: async (a) => {
      const c = await campaigns().get(a.id);
      const digest = new DigestService();
      const per =
        c.kind === 'weekly_digest'
          ? async (contact: Contact) => (await digest.buildFor([contact], new Date())).get(contact.id)?.blocks ?? null
          : undefined;
      const previews = await renderForSamples({ id: c.id, templateKey: c.templateKey, class: c.class, kind: c.kind, subject: c.subject, preheader: c.preheader, content: c.content as Block[], utmCampaign: c.utmCampaign }, 3, per);
      return previews.map((p) => ({ label: p.label, subject: p.subject, text: p.text, ...(a.html ? { html: p.html } : {}) }));
    },
  },
  {
    name: 'email_send_test',
    description: 'Send the campaign to test addresses. Only addresses on EMAIL_TEST_ALLOWLIST; always allowed. In sandbox mode SendGrid delivers nothing.',
    input: { id: z.string().uuid(), emails: z.array(z.string()).min(1).max(10) },
    handler: (a, ctx) => operator().sendTest(a.id, a.emails, ctx.actor),
  },
  {
    name: 'email_schedule_campaign',
    description:
      'Schedule a draft. Marketing that Claude schedules for more than the approval threshold (50 contacts) becomes pending_approval and waits for a person; otherwise it is scheduled.',
    input: { id: z.string().uuid(), scheduled_at: z.string().datetime().optional() },
    handler: (a, ctx) => campaigns().schedule(a.id, { actor: ctx.actor, scheduledAt: a.scheduled_at ? new Date(a.scheduled_at) : undefined }),
  },
  {
    name: 'email_approve_campaign',
    description: 'Approve a pending campaign. Approval is a human check: it only works from an MCP key with the email:approve scope; otherwise approve it in the admin (Messaging → Campaigns).',
    input: { id: z.string().uuid() },
    handler: (a, ctx) => {
      if (!ctx.canApprove) throw new Error('approval needs a person: approve it in the admin (Messaging → Campaigns → Approval queue)');
      return campaigns().approve(a.id, ctx.actor);
    },
  },
  {
    name: 'email_cancel_campaign',
    description: 'Cancel a campaign (and its queued sends) before it has finished.',
    input: { id: z.string().uuid() },
    handler: (a) => campaigns().cancel(a.id),
  },
  {
    name: 'email_pause_campaign',
    description: 'Pause a campaign that is sending; its queued sends wait.',
    input: { id: z.string().uuid() },
    handler: (a) => campaigns().pause(a.id),
  },
  {
    name: 'email_resume_campaign',
    description: 'Resume a paused campaign: its queued sends go out again within the rate limit.',
    input: { id: z.string().uuid() },
    handler: (a) => campaigns().resume(a.id),
  },
  {
    name: 'email_get_campaign_report',
    description: 'A campaign and its report: sent, delivered, clicked, orders, revenue per 1,000 sent, unsubscribes, complaints, per-link clicks, A/B results. Lists recent campaigns when no id is given. Read only.',
    input: { id: z.string().uuid().optional(), status: z.enum(['draft', 'pending_approval', 'scheduled', 'sending', 'paused', 'sent', 'cancelled']).optional() },
    handler: async (a) => {
      if (!a.id) return campaigns().list({ status: a.status, limit: 50 });
      return { campaign: await campaigns().get(a.id), report: await new ReportsService().campaignReport(a.id) };
    },
  },
  {
    name: 'email_list_automations',
    description: 'Each automation with its switch, cadence and policy settings, and its last 30 days. Read only.',
    input: {},
    handler: () => operator().automations(),
  },
  {
    name: 'email_update_automation',
    description: 'Switch an automation on or off, or change its cadence and policy settings (discount_allowed, discount_code, …).',
    input: { key: z.string(), settings: z.record(z.unknown()) },
    handler: (a, ctx) => operator().updateAutomation(a.key, a.settings, ctx.actor),
  },
  {
    name: 'email_get_deliverability',
    description: '7- and 30-day bounce and complaint rates by class, the auto-pause thresholds, send mode, pause state, last webhook event, last suppression reconciliation, rate limit. Read only.',
    input: {},
    handler: () => operator().deliverability(),
  },
  {
    name: 'email_pause_marketing',
    description: 'Global kill switch: stop every marketing send now (queued marketing waits). Order and requested mail still go.',
    input: { reason: z.string().min(3) },
    handler: (a, ctx) => operator().setMarketingPaused(true, ctx.actor, a.reason),
  },
  {
    name: 'email_resume_marketing',
    description: 'Lift the global marketing pause.',
    input: {},
    handler: (_a, ctx) => operator().setMarketingPaused(false, ctx.actor),
  },
  {
    name: 'email_get_settings',
    description: 'Every email setting (rate limit, send window, marketing gap, approval threshold, digest day/time, decay, automations…). Read only.',
    input: {},
    handler: () => getEmailSettings(),
  },
  {
    name: 'email_update_settings',
    description: 'Change email settings. Each value must have the same shape as its current value; logged.',
    input: { settings: z.record(z.unknown()) },
    handler: (a, ctx) => updateEmailSettings(a.settings, ctx.actor),
  },
  {
    name: 'email_record_consent',
    description: 'Record consent gathered elsewhere (a trade show, a phone call): status all or transactional_only, with where it came from and evidence text. Logged as a consent event.',
    input: { email: z.string(), status: z.enum(['all', 'transactional_only']).default('all'), source: z.string().min(2), evidence: z.string().min(5) },
    handler: (a, ctx) => operator().recordConsent(a.email, { source: a.source, evidence: a.evidence, status: a.status }, ctx.actor, 'mcp'),
  },
  {
    name: 'email_write_weekly_content',
    description: "Write this week's featured paragraph (markdown) for a material, or a deal, used by the weekly digest. key: material:pla, material:petg, … or all. week: the Monday, YYYY-MM-DD (default this week).",
    input: {
      key: z.string(),
      kind: z.enum(['featured', 'deal']).default('featured'),
      body: z.string().min(5),
      title: z.string().optional(),
      url: z.string().url().optional(),
      price_gbp: z.string().optional(),
      saving_gbp: z.string().optional(),
      week: z.string().optional(),
    },
    handler: (a, ctx) =>
      operator().writeWeeklyContent({ key: a.key, kind: a.kind, body: a.body, title: a.title, url: a.url, priceGbp: a.price_gbp, savingGbp: a.saving_gbp, week: a.week }, ctx.actor),
  },
];
