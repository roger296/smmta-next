/**
 * Admin routes for the Messaging section (spec § Admin UI; runbook section
 * 11). JWT-gated like the rest of the admin. A thin layer over the same
 * services the MCP tools use; approval is only here (a person, signed in).
 * Every change is written to `email_audit` with the user as actor.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../../config/database.js';
import { emailAlerts, emailSettings, emailTemplates, emailWeeklyContent } from '../../../db/schema/index.js';
import { getAuthUser, requireAuth } from '../../../shared/middleware/auth.js';
import { displaySendMode, configuredSendMode } from '../lib/config.js';
import { MATERIALS } from '../lib/interests.js';
import { previewSegment, segmentSchema } from '../services/audience.service.js';
import { AbService } from '../services/ab.service.js';
import { CampaignError, CampaignsService } from '../services/campaigns.service.js';
import { ConsentTransitionError, ContactsService, type Contact } from '../services/contacts.service.js';
import { DigestService } from '../services/digest.service.js';
import { ImportRefusedError, ImportsService, LIST_TYPES, saveUploadedCsv } from '../services/imports.service.js';
import { audit, contactFilterSchema, OperatorService } from '../services/operator.service.js';
import { ReportsService } from '../services/reports.service.js';
import { getEmailSettings, SettingsValidationError, updateEmailSettings } from '../services/settings.service.js';
import { VerificationService } from '../services/verification.service.js';
import { checkDns } from '../services/dns.service.js';
import { BLOCK_TYPES, type Block } from '../templates/blocks.js';
import { renderForSamples, renderTemplate } from '../templates/render.js';
import { TEMPLATES } from '../templates/registry.js';
import { SAMPLE_DATA } from '../templates/fixtures.js';
import '../services/ab.service.js';

const actorOf = (r: FastifyRequest) => getAuthUser(r).userId ?? getAuthUser(r).email ?? 'admin';
const ok = <T>(data: T) => ({ success: true as const, data });

async function handled(reply: FastifyReply, fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof z.ZodError) return reply.status(400).send({ success: false, error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (err instanceof CampaignError) return reply.status(err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : 409).send({ success: false, error: err.message });
    if (err instanceof ConsentTransitionError) return reply.status(err.code === 'not_found' ? 404 : 409).send({ success: false, error: err.message, code: err.code });
    if (err instanceof ImportRefusedError) return reply.status(409).send({ success: false, error: err.message, code: err.code, details: err.report });
    if (err instanceof SettingsValidationError) return reply.status(400).send({ success: false, error: err.message });
    if (err instanceof Error && /not on the test allowlist|unknown automation|unknown interest key|week must be/.test(err.message)) {
      return reply.status(400).send({ success: false, error: err.message });
    }
    throw err;
  }
}

const blockSchema = z.object({ type: z.enum(BLOCK_TYPES as [string, ...string[]]), props: z.record(z.unknown()) });
const campaignBody = z.object({
  name: z.string().min(1),
  kind: z.enum(['manual', 'weekly_digest', 'new_product', 'automation']).default('manual'),
  class: z.enum(['marketing', 'service', 'requested_service']).default('marketing'),
  segment: segmentSchema.default({}),
  subject: z.string().default(''),
  preheader: z.string().nullable().optional(),
  templateKey: z.string().default('manual'),
  content: z.array(blockSchema).default([]),
  scheduledAt: z.string().datetime().nullable().optional(),
  sendWindowMinutes: z.number().int().min(0).max(1440).default(0),
  subjectB: z.string().optional(),
});

export async function emailAdminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  const operator = new OperatorService();
  const contacts = new ContactsService();
  const campaigns = new CampaignsService();
  const reports = new ReportsService();
  const imports = new ImportsService();

  // ---- Banner / overview ----
  app.get('/email/overview', async () => {
    const s = await getEmailSettings();
    const [pending] = (await getDb().execute(sql`select count(*)::int as n from email_campaigns where status = 'pending_approval'`)).rows as Array<{ n: number }>;
    const [alerts] = (await getDb().execute(sql`select count(*)::int as n from email_alerts where acknowledged_at is null`)).rows as Array<{ n: number }>;
    return ok({
      sendMode: displaySendMode(),
      sendModeSet: configuredSendMode() !== null,
      marketingPaused: s.marketing_paused,
      pausedReason: s.marketing_paused_reason,
      pendingApproval: pending?.n ?? 0,
      openAlerts: alerts?.n ?? 0,
      materials: MATERIALS.map((m) => ({ key: m.key, name: m.name })),
    });
  });

  // ---- Contacts ----
  const listQuery = contactFilterSchema.extend({
    page: z.coerce.number().int().min(1).default(1),
    page_size: z.coerce.number().int().min(1).max(200).default(50),
    is_trade: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
    engaged_within_days: z.coerce.number().int().positive().optional(),
    last_order_within_days: z.coerce.number().int().positive().optional(),
  });
  app.get('/email/contacts', (req, reply) => handled(reply, () => operator.listContacts(listQuery.parse(req.query))));

  app.get('/email/contacts/export.csv', async (req, reply) => {
    const f = listQuery.parse({ ...(req.query as object), page: 1, page_size: 200 });
    const rows: string[] = ['email,marketing_status,deliverability,is_trade,consent_source,interests,last_order_at,last_click_at'];
    for (let page = 1; page < 10_000; page++) {
      const r = await operator.listContacts({ ...f, page, page_size: 200 });
      for (const c of r.contacts) {
        rows.push([c.email, c.marketingStatus, c.deliverability, c.isTrade, c.consentSource, c.interests.join(';'), c.lastOrderAt?.toISOString() ?? '', c.lastClickAt?.toISOString() ?? ''].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
      }
      if (page * 200 >= r.total) break;
    }
    await audit('admin:contacts_export', actorOf(req), f, true, `${rows.length - 1} rows`);
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="email-contacts.csv"').send(rows.join('\n'));
  });

  app.get('/email/contacts/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const c = await operator.getContact(id);
    if (!c) return reply.status(404).send({ success: false, error: 'contact not found' });
    return ok(c);
  });

  const statusBody = z.object({ status: z.enum(['all', 'transactional_only', 'never']), reason: z.string().min(3), confirm: z.boolean().default(false) });
  app.post('/email/contacts/:id/status', (req, reply) =>
    handled(reply, async () => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = statusBody.parse(req.body);
      const r = await contacts.setMarketingStatus(id, b.status, { source: 'admin_ui', actor: actorOf(req), reason: b.reason, confirm: b.confirm, ip: req.ip });
      await audit('admin:set_status', actorOf(req), { id, ...b }, true, `${r.from} → ${r.to}`);
      return r;
    }),
  );

  app.post('/email/contacts/bulk-status', (req, reply) =>
    handled(reply, async () => {
      const b = statusBody.extend({ ids: z.array(z.string().uuid()).min(1).max(1000) }).parse(req.body);
      let changed = 0;
      const failed: string[] = [];
      for (const id of b.ids) {
        try {
          if ((await contacts.setMarketingStatus(id, b.status, { source: 'admin_ui', actor: actorOf(req), reason: b.reason, confirm: b.confirm })).changed) changed++;
        } catch {
          failed.push(id);
        }
      }
      await audit('admin:bulk_status', actorOf(req), { count: b.ids.length, status: b.status, reason: b.reason }, failed.length === 0, `${changed} changed, ${failed.length} refused`);
      return { changed, refused: failed.length };
    }),
  );

  app.post('/email/contacts/:id/reverify', (req, reply) =>
    handled(reply, async () => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const r = await new VerificationService().verifyContact(id, { force: true });
      await audit('admin:reverify', actorOf(req), { id }, true, JSON.stringify(r));
      return r;
    }),
  );

  app.post('/email/contacts/record-consent', (req, reply) =>
    handled(reply, async () => {
      const b = z.object({ email: z.string().min(3), status: z.enum(['all', 'transactional_only']).default('all'), source: z.string().min(2), evidence: z.string().min(5) }).parse(req.body);
      const r = await operator.recordConsent(b.email, b, actorOf(req), 'admin_ui');
      await audit('admin:record_consent', actorOf(req), b, true, JSON.stringify(r));
      return r;
    }),
  );

  // ---- Imports ----
  app.get('/email/imports', async () => ok(await imports.list(50)));
  app.get('/email/imports/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await imports.get(id);
    if (!r) return reply.status(404).send({ success: false, error: 'import not found' });
    return ok(r);
  });
  app.post('/email/imports', { bodyLimit: 64 * 1024 * 1024 }, (req, reply) =>
    handled(reply, async () => {
      const b = z
        .object({
          csvText: z.string().min(1),
          filename: z.string().min(1).max(200),
          listType: z.enum(LIST_TYPES),
          defaultStatus: z.enum(['all', 'transactional_only']).optional(),
          defaultInterests: z.array(z.string()).default([]),
          consentSource: z.string().default('sendgrid_import'),
          dryRun: z.boolean().default(true),
          dryRunId: z.string().uuid().optional(),
        })
        .parse(req.body);
      const path = await saveUploadedCsv(b.csvText);
      const r = await imports.run({ filePath: path, filename: b.filename, listType: b.listType, defaultStatus: b.defaultStatus, defaultInterests: b.defaultInterests, consentSource: b.consentSource, dryRun: b.dryRun, dryRunId: b.dryRunId, actor: actorOf(req) });
      await audit('admin:import', actorOf(req), { filename: b.filename, listType: b.listType, dryRun: b.dryRun }, true, `rows ${r.rows_read}, create ${r.would_create}`);
      return r;
    }),
  );

  // ---- Segments ----
  app.post('/email/segments/preview', (req, reply) =>
    handled(reply, async () => {
      const b = z.object({ segment: segmentSchema.default({}), class: z.enum(['marketing', 'service', 'requested_service']).default('marketing'), kind: z.string().default('manual') }).parse(req.body);
      return previewSegment(b.segment, { class: b.class, kind: b.kind });
    }),
  );

  // ---- Campaigns ----
  app.get('/email/campaigns', async (req) => {
    const q = z.object({ status: z.enum(['draft', 'pending_approval', 'scheduled', 'sending', 'paused', 'sent', 'cancelled']).optional() }).parse(req.query);
    return ok(await campaigns.list({ status: q.status, limit: 200 }));
  });

  app.post('/email/campaigns', (req, reply) =>
    handled(reply, async () => {
      const b = campaignBody.parse(req.body);
      const c = await campaigns.create({ ...b, content: b.content as Block[], scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : null }, actorOf(req));
      if (b.subjectB) await new AbService().createVariant(c.id, b.subjectB, actorOf(req));
      await audit('admin:create_campaign', actorOf(req), { name: b.name, kind: b.kind }, true, c.id);
      return c;
    }),
  );

  app.get('/email/campaigns/:id', (req, reply) =>
    handled(reply, async () => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const c = await campaigns.get(id);
      const variant = await new AbService().variantOf(c);
      return { campaign: c, variant: variant ?? null, report: await reports.campaignReport(id), sends: await reports.campaignSends(id, 50) };
    }),
  );

  app.patch('/email/campaigns/:id', (req, reply) =>
    handled(reply, async () => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = campaignBody.partial().parse(req.body);
      const c = await campaigns.update(id, { ...b, content: b.content as Block[] | undefined, scheduledAt: b.scheduledAt === undefined ? undefined : b.scheduledAt ? new Date(b.scheduledAt) : null });
      if (b.subjectB !== undefined) {
        if (b.subjectB) await new AbService().createVariant(id, b.subjectB, actorOf(req));
        else {
          const v = await new AbService().variantOf(c);
          if (v) await campaigns.cancel(v.id);
        }
      }
      await audit('admin:update_campaign', actorOf(req), { id }, true, c.status);
      return c;
    }),
  );

  const act = (path: string, fn: (id: string, req: FastifyRequest) => Promise<unknown>) =>
    app.post(`/email/campaigns/:id/${path}`, (req, reply) =>
      handled(reply, async () => {
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const r = await fn(id, req);
        await audit(`admin:${path}_campaign`, actorOf(req), { id }, true, (r as { status?: string })?.status ?? 'ok');
        return r;
      }),
    );
  act('schedule', (id, req) => {
    const b = z.object({ scheduledAt: z.string().datetime().optional() }).parse(req.body ?? {});
    return campaigns.schedule(id, { actor: actorOf(req), scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : undefined });
  });
  act('approve', (id, req) => campaigns.approve(id, actorOf(req)));
  act('cancel', (id) => campaigns.cancel(id));
  act('pause', (id) => campaigns.pause(id));
  act('resume', (id) => campaigns.resume(id));
  act('test-send', (id, req) => {
    const b = z.object({ emails: z.array(z.string()).min(1).max(10) }).parse(req.body);
    return operator.sendTest(id, b.emails, actorOf(req));
  });

  app.get('/email/campaigns/:id/preview', (req, reply) =>
    handled(reply, async () => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const c = await campaigns.get(id);
      const digest = new DigestService();
      const per =
        c.kind === 'weekly_digest' ? async (contact: Contact) => (await digest.buildFor([contact], new Date())).get(contact.id)?.blocks ?? null : undefined;
      return renderForSamples({ id: c.id, templateKey: c.templateKey, class: c.class, kind: c.kind, subject: c.subject, preheader: c.preheader, content: c.content as Block[], utmCampaign: c.utmCampaign }, 3, per);
    }),
  );

  // ---- Automations ----
  app.get('/email/automations', async () => ok(await operator.automations()));
  app.patch('/email/automations/:key', (req, reply) =>
    handled(reply, async () => {
      const { key } = z.object({ key: z.string() }).parse(req.params);
      const r = await operator.updateAutomation(key, z.record(z.unknown()).parse(req.body), actorOf(req));
      await audit('admin:update_automation', actorOf(req), { key, ...(req.body as object) }, true, `enabled=${r.enabled}`);
      return r;
    }),
  );

  // ---- Templates ----
  app.get('/email/templates', async () => {
    const rows = await getDb().select().from(emailTemplates).orderBy(emailTemplates.key, desc(emailTemplates.version));
    return ok(
      Object.values(TEMPLATES).map((t) => ({
        key: t.key,
        class: t.class,
        why: t.why,
        versions: rows.filter((r) => r.key === t.key).map((r) => ({ version: r.version, createdAt: r.createdAt, bodySource: r.bodySource })),
      })),
    );
  });
  app.get('/email/templates/:key/preview', (req, reply) =>
    handled(reply, async () => {
      const { key } = z.object({ key: z.string() }).parse(req.params);
      if (!TEMPLATES[key]) throw new CampaignError('unknown template', 'not_found');
      return renderTemplate({ templateKey: key, kind: key, data: SAMPLE_DATA[key] ?? {}, contact: { id: '00000000-0000-4000-8000-000000000000', unsubscribeToken: 'preview', isTrade: false }, sendId: 'preview' });
    }),
  );

  // ---- Weekly content ----
  app.get('/email/weekly-content', async (req) => {
    const { week } = z.object({ week: z.string().optional() }).parse(req.query);
    const rows = await getDb().select().from(emailWeeklyContent).where(week ? eq(emailWeeklyContent.weekStart, week) : undefined).orderBy(desc(emailWeeklyContent.createdAt)).limit(200);
    return ok(rows);
  });
  app.post('/email/weekly-content', (req, reply) =>
    handled(reply, async () => {
      const b = z.object({ key: z.string(), kind: z.enum(['featured', 'deal']), body: z.string().min(3), title: z.string().optional(), url: z.string().url().optional(), priceGbp: z.string().optional(), savingGbp: z.string().optional(), week: z.string().optional() }).parse(req.body);
      const r = await operator.writeWeeklyContent(b, actorOf(req));
      await audit('admin:weekly_content', actorOf(req), { key: b.key, kind: b.kind }, true, r.id);
      return r;
    }),
  );
  app.delete('/email/weekly-content/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await getDb().delete(emailWeeklyContent).where(eq(emailWeeklyContent.id, id));
    return ok({ deleted: id });
  });

  // ---- Deliverability ----
  app.get('/email/deliverability', async () => {
    const [dns] = await getDb().select().from(emailSettings).where(eq(emailSettings.key, 'status_dns'));
    const alerts = await getDb().select().from(emailAlerts).orderBy(desc(emailAlerts.createdAt)).limit(20);
    return ok({ ...(await operator.deliverability()), daily: await reports.deliverabilityReport(90), dns: dns?.value ?? null, alerts });
  });
  app.post('/email/deliverability/pause', (req, reply) =>
    handled(reply, async () => {
      const b = z.object({ reason: z.string().min(3) }).parse(req.body);
      const r = await operator.setMarketingPaused(true, actorOf(req), b.reason);
      await audit('admin:pause_marketing', actorOf(req), b, true, 'paused');
      return r;
    }),
  );
  app.post('/email/deliverability/resume', (req, reply) =>
    handled(reply, async () => {
      const r = await operator.setMarketingPaused(false, actorOf(req));
      await audit('admin:resume_marketing', actorOf(req), {}, true, 'resumed');
      return r;
    }),
  );
  app.post('/email/deliverability/dns-check', async () => ok(await checkDns()));
  app.post('/email/alerts/:id/ack', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await getDb().update(emailAlerts).set({ acknowledgedAt: new Date(), acknowledgedBy: actorOf(req) }).where(and(eq(emailAlerts.id, id)));
    return ok({ acknowledged: id });
  });

  // ---- Settings ----
  app.get('/email/settings', async () => ok(await getEmailSettings()));
  app.put('/email/settings', (req, reply) =>
    handled(reply, async () => {
      const patch = z.record(z.unknown()).parse(req.body);
      const s = await updateEmailSettings(patch, actorOf(req));
      await audit('admin:update_settings', actorOf(req), patch, true, Object.keys(patch).join(','));
      return s;
    }),
  );

  // ---- Audit ----
  app.get('/email/audit', async () => {
    const rows = (await getDb().execute(sql`select * from email_audit order by created_at desc limit 200`)).rows;
    return ok(rows);
  });

}
