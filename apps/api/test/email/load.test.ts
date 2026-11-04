/**
 * Load check (runbook section 13): 20,000 contacts — digest expansion under
 * 30 s, each sender batch under 1 s, the campaign report under 500 ms.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../../src/config/database.js';
import { getSingletonCompanyId } from '../../src/shared/auth/company.js';
import { emailCampaigns, emailSends, productGroups, products } from '../../src/db/schema/index.js';
import { CampaignsService } from '../../src/modules/email/services/campaigns.service.js';
import { DigestService } from '../../src/modules/email/services/digest.service.js';
import { processQueue } from '../../src/modules/email/services/sender.service.js';
import { ReportsService } from '../../src/modules/email/services/reports.service.js';
import { resetBucket } from '../../src/modules/email/lib/rate-limit.js';
import { addInterestPoints } from '../../src/modules/email/lib/interests.js';
import { cleanupFixtures, makeContacts, withSettings } from '../../src/modules/email/testing.js';

const THU = new Date('2033-03-10T10:00:00Z');
let campaignId = '';
const productIds: string[] = [];
let groupId = '';

afterAll(async () => {
  if (campaignId) {
    await getDb().delete(emailSends).where(eq(emailSends.campaignId, campaignId));
    await getDb().delete(emailCampaigns).where(eq(emailCampaigns.id, campaignId));
  }
  await cleanupFixtures();
  if (productIds.length) await getDb().delete(products).where(inArray(products.id, productIds));
  if (groupId) await getDb().delete(productGroups).where(eq(productGroups.id, groupId));
});

describe('load', () => {
  it('20,000 contacts: expansion < 30 s, sender batches < 1 s, report < 500 ms', async () => {
    const company = getSingletonCompanyId();
    const [g] = await getDb().insert(productGroups).values({ companyId: company, name: 'Load PLA 1.75mm', slug: `load-${Date.now()}` }).returning();
    groupId = g!.id;
    for (const colour of ['Red', 'Blue', 'Green']) {
      const [p] = await getDb().insert(products).values({ companyId: company, name: `Load PLA ${colour}`, groupId: g!.id, slug: `load-${Date.now()}-${colour}`, isPublished: true, minSellingPrice: '17.99', createdAt: new Date(THU.getTime() - 2 * 86_400_000) }).returning();
      productIds.push(p!.id);
    }
    const interests = addInterestPoints({}, ['material:pla'], 10, new Date(THU.getTime() - 86_400_000));
    const people = await makeContacts(20_000, { interests, lastDigestAt: new Date(THU.getTime() - 7 * 86_400_000) });

    const campaigns = new CampaignsService();
    void new DigestService(); // registers the digest builder
    const c = await campaigns.create({ name: 'Load digest', kind: 'weekly_digest', templateKey: 'weekly_digest', segment: { status: 'all', contact_ids: people.map((p) => p.id) }, scheduledAt: THU, sendWindowMinutes: 180 }, 'system');
    campaignId = c.id;
    await getDb().update(emailCampaigns).set({ status: 'scheduled' }).where(eq(emailCampaigns.id, c.id));

    const t0 = performance.now();
    const res = await campaigns.expand(c.id, THU);
    const expandMs = performance.now() - t0;
    expect(res.queued).toBe(20_000);
    expect(expandMs).toBeLessThan(30_000);

    // Sender: other queued rows set aside; a generous rate so batches are full.
    await getDb().update(emailSends).set({ status: 'dropped', dropReason: 'load_isolation' }).where(eq(emailSends.status, 'queued'));
    await getDb().update(emailSends).set({ status: 'queued', dropReason: null }).where(eq(emailSends.campaignId, c.id));
    await resetBucket();
    const restore = await withSettings({ rate_limit_per_hour: 60_000 });
    const batchMs: number[] = [];
    try {
      const transport = { send: async () => ({ messageId: 'load' }) };
      for (let i = 0; i < 5; i++) {
        const s = performance.now();
        const r = await processQueue({ now: new Date(THU.getTime() + 181 * 60_000 + i * 60_000), mode: 'sandbox', transport });
        batchMs.push(performance.now() - s);
        expect(r.sent).toBe(50);
      }
    } finally {
      await restore();
      await resetBucket();
    }
    expect(Math.max(...batchMs)).toBeLessThan(1000);

    await getDb().execute(`analyze email_sends` as never);
    await new ReportsService().campaignReport(c.id);
    const r0 = performance.now();
    const report = await new ReportsService().campaignReport(c.id);
    expect(performance.now() - r0).toBeLessThan(500);
    expect(report.total).toBe(20_000);
    console.log(JSON.stringify({ expandMs: Math.round(expandMs), batchMs: batchMs.map(Math.round), reportMs: Math.round(performance.now() - r0) }));
  }, 120_000);
});
