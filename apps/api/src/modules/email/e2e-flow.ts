/**
 * The whole email system end to end in sandbox mode (runbook section 13):
 * backfill → the four SendGrid imports → a weekly digest drafted and sent →
 * SendGrid's webhook events replayed → automations → reports. Used by
 * scripts/email/e2e-sandbox.ts (against a fresh database) and by
 * test/email/e2e.test.ts. Every address is @example.com; nothing leaves the
 * process (the SendGrid transport is a recorder).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import { customers, emailCampaigns, emailContacts, emailSends, productGroups, products } from '../../db/schema/index.js';
import { BackfillService } from './services/backfill.service.js';
import { ImportsService, type ListType } from './services/imports.service.js';
import { DigestService } from './services/digest.service.js';
import { CampaignsService } from './services/campaigns.service.js';
import { processQueue } from './services/sender.service.js';
import { EventsService } from './services/events.service.js';
import { runAutomations } from './services/automations.service.js';
import { ReportsService } from './services/reports.service.js';
import { resetBucket } from './lib/rate-limit.js';
import type { EmailTransport } from './lib/sendgrid.js';
import { addInterestPoints } from './lib/interests.js';

export interface FlowResult {
  backfill: Awaited<ReturnType<BackfillService['run']>>;
  imports: Record<string, { created: number; updated: number }>;
  digestCampaignId: string;
  digestSent: number;
  events: { stored: number };
  automations: Array<{ key: string; candidates: number }>;
  report: Awaited<ReturnType<ReportsService['campaignReport']>>;
  statuses: Record<string, { marketingStatus: string; deliverability: string }>;
}

export async function runEmailE2E(opts: { tag?: string; now?: Date } = {}): Promise<FlowResult> {
  const tag = opts.tag ?? Date.now().toString(36);
  const db = getDb();
  const company = getSingletonCompanyId();
  const e = (n: string) => `e2e-${tag}-${n}@example.com`;
  // Thursday 10:00 UK, a fixed week far from real data.
  const thursday = opts.now ?? new Date('2032-03-11T10:00:00Z');
  const wednesday = new Date(thursday.getTime() - 86_400_000);

  // A customer the backfill turns into a contact, and a fresh product.
  await db.insert(customers).values({ companyId: company, name: 'E2E Customer', email: e('customer') });
  const [g] = await db.insert(productGroups).values({ companyId: company, name: 'E2E PLA Basic 1.75mm 1kg', slug: `e2e-${tag}` }).returning();
  await db.insert(products).values({ companyId: company, name: 'E2E PLA Green', groupId: g!.id, slug: `e2e-${tag}-green`, isPublished: true, minSellingPrice: '17.99', createdAt: new Date(wednesday.getTime() - 86_400_000) });

  const backfill = await new BackfillService().run();

  // The four exports, in order.
  const dir = mkdtempSync(join(tmpdir(), 'email-e2e-'));
  const files: Array<[ListType, string]> = [
    ['bounces', `email,created\n${e('bounced')},1709287200\n`],
    ['spam_reports', `email,created\n${e('complainer')},1709287200\n`],
    ['unsubscribes', `email,created\n${e('unsub')},1709287200\n`],
    ['contacts', `EMAIL,CREATED_AT\n${e('bounced')},2024-01-01\n${e('complainer')},2024-01-01\n${e('unsub')},2024-01-01\n${e('fan')},2024-01-01\n${e('fan2')},2024-01-01\n`],
  ];
  const imports: FlowResult['imports'] = {};
  const svc = new ImportsService();
  for (const [type, body] of files) {
    const path = join(dir, `${type}-${tag}.csv`);
    writeFileSync(path, body);
    const dry = await svc.run({ filePath: path, listType: type, dryRun: true, actor: 'e2e', defaultInterests: ['material:pla'] });
    const live = await svc.run({ filePath: path, listType: type, dryRun: false, dryRunId: dry.importId, actor: 'e2e', defaultInterests: ['material:pla'] });
    imports[type] = { created: live.created ?? 0, updated: live.updated ?? 0 };
  }
  const mine = await db.select().from(emailContacts).where(inArray(emailContacts.email, ['fan', 'fan2', 'bounced', 'complainer', 'unsub'].map(e)));
  for (const c of mine) {
    await db.update(emailContacts).set({ interests: addInterestPoints({}, ['material:pla'], 10, wednesday), lastDigestAt: new Date(wednesday.getTime() - 7 * 86_400_000) }).where(eq(emailContacts.id, c.id));
  }

  // The digest: drafted Wednesday, narrowed to this run's contacts, sent
  // Thursday. A digest left for this week by an earlier run goes first.
  const old = await db.select({ id: emailCampaigns.id }).from(emailCampaigns).where(eq(emailCampaigns.utmCampaign, `digest-${thursday.toISOString().slice(0, 10)}`));
  for (const o of old) {
    await db.execute(sql`delete from email_events where send_id in (select id from email_sends where campaign_id = ${o.id})`);
    await db.delete(emailSends).where(eq(emailSends.campaignId, o.id));
    await db.delete(emailCampaigns).where(eq(emailCampaigns.id, o.id));
  }
  const digest = await new DigestService().createWeeklyDigest(wednesday);
  await db.update(emailCampaigns).set({ segment: { status: 'all', contact_ids: mine.map((m) => m.id) } }).where(eq(emailCampaigns.id, digest.id));
  const campaigns = new CampaignsService();
  await campaigns.tick(thursday);
  // The queue is global: set other queued rows aside so the run is about this one.
  await db.update(emailSends).set({ status: 'dropped', dropReason: 'e2e_isolation' }).where(eq(emailSends.status, 'queued'));
  await db.update(emailSends).set({ status: 'queued', dropReason: null }).where(eq(emailSends.campaignId, digest.id));
  await resetBucket();
  const recorded: Array<Record<string, any>> = [];
  const transport: EmailTransport = { send: async (p) => { recorded.push(p as Record<string, any>); return { messageId: `e2e-${recorded.length}` }; } };
  let digestSent = 0;
  for (let m = 0; m <= 185; m += 5) digestSent += (await processQueue({ now: new Date(thursday.getTime() + m * 60_000), mode: 'sandbox', transport })).sent;

  // SendGrid's events for what went out: delivered for all, a click for one.
  const sent = await db.select().from(emailSends).where(eq(emailSends.campaignId, digest.id));
  const ts = Math.floor(thursday.getTime() / 1000) + 3600;
  const events = sent.flatMap((s, i) => [
    { email: 'x@example.com', event: 'delivered', sg_event_id: `e2e-${tag}-${s.id}-d`, timestamp: ts, send_id: s.id },
    ...(i === 0 ? [{ email: 'x@example.com', event: 'click', sg_event_id: `e2e-${tag}-${s.id}-c`, timestamp: ts + 60, send_id: s.id, url: 'https://filament.cleverdeals.net/shop/x?ik=material:pla' }] : []),
  ]);
  const ingest = await new EventsService().ingest(events);

  const automations = (await runAutomations(new Date(thursday.getTime() + 4 * 3_600_000), { countOnly: true, ignoreSwitches: true })).map(({ key, candidates }) => ({ key, candidates }));
  await campaigns.tick(new Date(thursday.getTime() + 4 * 3_600_000));
  const report = await new ReportsService().campaignReport(digest.id);

  const after = await db.select().from(emailContacts).where(inArray(emailContacts.email, ['fan', 'fan2', 'bounced', 'complainer', 'unsub', 'customer'].map(e)));
  const statuses = Object.fromEntries(after.map((c) => [c.email.split('-')[2]!.split('@')[0]!, { marketingStatus: c.marketingStatus, deliverability: c.deliverability }]));
  return { backfill, imports, digestCampaignId: digest.id, digestSent, events: { stored: ingest.stored }, automations, report, statuses };
}
