/**
 * Weekly digest, new-product roll-up, campaigns and segments (runbook
 * section 8). Dates are in 2031 so nothing other suites created falls in the
 * windows; campaigns are narrowed to this file's contacts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { getSingletonCompanyId } from '../../../shared/auth/company.js';
import {
  emailCampaigns,
  emailContacts,
  emailSends,
  emailWeeklyContent,
  products,
  stockItems,
  warehouses,
} from '../../../db/schema/index.js';
import { addInterestPoints } from '../lib/interests.js';
import { CampaignsService } from './campaigns.service.js';
import { DigestService, nextWeekdayAt, weekStartOf } from './digest.service.js';
import { segmentContacts } from './audience.service.js';
import { processQueue } from './sender.service.js';
import type { EmailTransport } from '../lib/sendgrid.js';
import { resetBucket } from '../lib/rate-limit.js';
import { cleanupFixtures, makeContact, makeGroup, makeProduct, withSettings } from '../testing.js';

const COMPANY = getSingletonCompanyId();
const WED = new Date('2031-03-12T10:00:00Z'); // Wednesday 10:00 UK (GMT)
const THU = new Date('2031-03-13T10:00:00Z');
const DAY = 86_400_000;
const campaigns = new CampaignsService();
const digest = new DigestService();
let warehouseId: string;
const extraProducts: string[] = [];

async function interested(keys: string[], status: 'all' | 'transactional_only' = 'all') {
  const c = await makeContact({ initialStatus: status });
  const interests = keys.length ? addInterestPoints({}, keys, 10, new Date(WED.getTime() - DAY)) : {};
  await getDb().update(emailContacts).set({ interests, lastDigestAt: new Date(WED.getTime() - 7 * DAY) }).where(eq(emailContacts.id, c.id));
  return c;
}

async function product(name: string, groupName: string, createdAt: Date, extra: Partial<typeof products.$inferInsert> = {}) {
  const g = await makeGroup(groupName);
  const p = await makeProduct(name, { groupId: g.id, ...extra });
  await getDb().update(products).set({ createdAt }).where(eq(products.id, p.id));
  return p;
}

beforeAll(async () => {
  await dropTestCampaigns();
  const [w] = await getDb().insert(warehouses).values({ companyId: COMPANY, name: 'Digest WH' }).returning();
  warehouseId = w!.id;
  // The fixture week: three new PLA products, one PETG back in stock, one deal.
  for (const colour of ['Red', 'Blue', 'Green']) await product(`PLA ${colour}`, 'Landu PLA Basic 1.75mm 1kg', new Date(WED.getTime() - 2 * DAY), { colour });
  const petg = await product('PETG Clear', 'Landu PETG Pro 1.75mm 1kg', new Date(WED.getTime() - 90 * DAY), { colour: 'Clear' });
  extraProducts.push(petg.id);
  await getDb().insert(stockItems).values({ companyId: COMPANY, productId: petg.id, warehouseId, status: 'IN_STOCK', quantity: 1, createdAt: new Date(WED.getTime() - DAY) });
  await getDb().insert(emailWeeklyContent).values([
    { companyId: COMPANY, weekStart: weekStartOf(THU), key: 'material:petg', kind: 'deal', title: '3 PETG spools', body: 'any colours', priceGbp: '54.00', createdBy: 'test' },
    { companyId: COMPANY, weekStart: weekStartOf(THU), key: 'material:pla', kind: 'featured', title: 'PLA tip', body: 'Dry your **PLA** if it pops.', createdBy: 'test' },
  ]);
});

async function dropTestCampaigns() {
  const ids = (
    await getDb().select({ id: emailCampaigns.id }).from(emailCampaigns).where(sql`${emailCampaigns.utmCampaign} like 'digest-2031%' or ${emailCampaigns.utmCampaign} like 'new-2031%'`)
  ).map((r) => r.id);
  if (ids.length) {
    await getDb().delete(emailSends).where(inArray(emailSends.campaignId, ids));
    await getDb().delete(emailCampaigns).where(inArray(emailCampaigns.id, ids));
  }
}

afterAll(async () => {
  await dropTestCampaigns();
  await getDb().delete(stockItems).where(inArray(stockItems.productId, extraProducts));
  await getDb().delete(warehouses).where(eq(warehouses.id, warehouseId));
  await getDb().delete(emailWeeklyContent).where(eq(emailWeeklyContent.createdBy, 'test'));
  await cleanupFixtures();
});

describe('dates', () => {
  it('finds the next Thursday 10:00 UK and the week start', () => {
    expect(nextWeekdayAt(WED, 4, '10:00').toISOString()).toBe('2031-03-13T10:00:00.000Z');
    expect(nextWeekdayAt(new Date('2031-07-02T10:00:00Z'), 4, '10:00').toISOString()).toBe('2031-07-03T09:00:00.000Z'); // BST
    expect(weekStartOf(THU)).toBe('2031-03-10');
  });
});

describe('weekly digest', () => {
  it('a full cycle: Wednesday draft, Thursday send to the right people, spread over 180 minutes', async () => {
    const pla = await interested(['material:pla']);
    const petg = await interested(['material:petg']);
    const fresh = await interested([]);
    const absOnly = await interested(['material:abs']);
    const optedOut = await interested(['material:pla'], 'transactional_only');
    const mine = [pla, petg, fresh, absOnly, optedOut];

    const c = await digest.createWeeklyDigest(WED);
    expect(c).toMatchObject({ kind: 'weekly_digest', status: 'scheduled', sendWindowMinutes: 180 });
    expect(c.scheduledAt!.toISOString()).toBe(THU.toISOString());
    expect((await digest.createWeeklyDigest(WED)).id).toBe(c.id); // once a week
    // Narrow the standing segment to this file's contacts.
    await getDb().update(emailCampaigns).set({ segment: { status: 'all', contact_ids: mine.map((m) => m.id) } }).where(eq(emailCampaigns.id, c.id));

    await campaigns.tick(new Date(THU.getTime() - 60_000));
    expect((await campaigns.get(c.id)).status).toBe('scheduled');
    await campaigns.tick(THU);
    expect((await campaigns.get(c.id)).status).toBe('sending');
    const rows = await getDb().select().from(emailSends).where(eq(emailSends.campaignId, c.id));
    const by = new Map(rows.map((r) => [r.contactId, r]));
    expect([...by.keys()].sort()).toEqual([pla.id, petg.id, fresh.id].sort());

    const blocksOf = (id: string) => ((by.get(id)!.data as { blocks: Array<{ type: string; props: Record<string, any> }> }).blocks);
    const plaBlocks = blocksOf(pla.id);
    expect(plaBlocks[0]!.props.title).toBe('New in PLA');
    expect(plaBlocks[0]!.props.products).toHaveLength(3);
    expect(plaBlocks.some((b) => b.type === 'FeaturedText')).toBe(true);
    expect(plaBlocks.some((b) => b.type === 'DealsList')).toBe(false);
    const petgBlocks = blocksOf(petg.id);
    expect(petgBlocks.map((b) => b.type)).toEqual(['ProductGrid', 'DealsList']);
    expect(petgBlocks[0]!.props.title).toBe('Back in stock');
    expect(blocksOf(fresh.id)[0]!.props.title).toBe('New in this week');

    // Nothing relevant: no send, but the digest window still moves on.
    const [abs] = await getDb().select().from(emailContacts).where(eq(emailContacts.id, absOnly.id));
    expect(abs!.lastDigestAt!.toISOString()).toBe(THU.toISOString());

    const times = rows.map((r) => r.notBefore.getTime()).sort();
    expect(times[0]).toBeGreaterThanOrEqual(THU.getTime());
    expect(times.at(-1)! - THU.getTime()).toBeLessThanOrEqual(180 * 60_000);
    expect(times.at(-1)! - THU.getTime()).toBeGreaterThan(60 * 60_000);

    // And the sender takes them in sandbox mode.
    // Set aside other suites' queued rows: the queue is global.
    await getDb().update(emailSends).set({ status: 'dropped', dropReason: 'test_isolation' }).where(and(eq(emailSends.status, 'queued'), sql`${emailSends.campaignId} is distinct from ${c.id}`));
    await resetBucket();
    const sent: Array<Record<string, any>> = [];
    const transport: EmailTransport = { send: async (p) => { sent.push(p as Record<string, any>); return { messageId: `m${sent.length}` }; } };
    for (let m = 0; m <= 180; m += 5) await processQueue({ now: new Date(THU.getTime() + m * 60_000), mode: 'sandbox', transport });
    const done = await getDb().select().from(emailSends).where(eq(emailSends.campaignId, c.id));
    expect(done.every((r) => r.status === 'sent')).toBe(true);
    expect(sent.find((p) => p.personalizations[0].custom_args.contact_id === pla.id)!.subject).toBe("What's new at CleverDeals this week");
    await campaigns.tick(new Date(THU.getTime() + 181 * 60_000));
    expect((await campaigns.get(c.id)).status).toBe('sent');
  });
});

describe('new-product roll-up', () => {
  const TUE_11 = new Date('2031-04-08T10:00:00Z'); // Tuesday 11:00 BST
  it('five products on one day → one email per interested contact; gap and hero rules', async () => {
    for (let i = 0; i < 5; i++) await product(`TPU Shade ${i}`, 'Flexi TPU 95A 1.75mm', new Date(TUE_11.getTime() - 3_600_000));
    const fan = await interested(['material:tpu']);
    const recent = await interested(['material:tpu']);
    await getDb().update(emailContacts).set({ lastMarketingAt: new Date(TUE_11.getTime() - 3 * DAY) }).where(eq(emailContacts.id, recent.id));
    const other = await interested(['material:pla']);
    const restore = await withSettings({ digest_due_skip_hours: 0 });
    try {
      const c = (await digest.createNewProductRollup(TUE_11))!;
      expect(c.overrideGap).toBe(false);
      await getDb().update(emailCampaigns).set({ segment: { status: 'all', contact_ids: [fan.id, recent.id, other.id] } }).where(eq(emailCampaigns.id, c.id));
      await campaigns.expand(c.id, TUE_11);
      const rows = await getDb().select().from(emailSends).where(eq(emailSends.campaignId, c.id));
      expect(rows.map((r) => r.contactId)).toEqual([fan.id]);
      expect(((rows[0]!.data as any).blocks[0].props.products as unknown[]).length).toBe(5);

      // A hero product overrides the 7-day gap (not the 24-hour floor).
      await product('TPU Hero', 'Flexi TPU 95A 1.75mm', new Date(TUE_11.getTime() + DAY - 3_600_000), { hero: true });
      const next = new Date(TUE_11.getTime() + DAY);
      const h = (await digest.createNewProductRollup(next))!;
      expect(h.overrideGap).toBe(true);
      await getDb().update(emailCampaigns).set({ segment: { status: 'all', contact_ids: [recent.id] } }).where(eq(emailCampaigns.id, h.id));
      await campaigns.expand(h.id, next);
      expect(await getDb().select().from(emailSends).where(eq(emailSends.campaignId, h.id))).toHaveLength(1);
    } finally {
      await restore();
    }
  });

  it('skips contacts whose digest is due within 48 hours', async () => {
    const WED_11 = new Date('2031-04-16T10:00:00Z'); // Wednesday, digest Thursday
    await product('ASA Black', 'Polymaker ASA 1.75mm', new Date(WED_11.getTime() - 3_600_000));
    const fan = await interested(['material:asa']);
    const c = (await digest.createNewProductRollup(WED_11))!;
    await getDb().update(emailCampaigns).set({ segment: { status: 'all', contact_ids: [fan.id] } }).where(eq(emailCampaigns.id, c.id));
    await campaigns.expand(c.id, WED_11);
    expect(await getDb().select().from(emailSends).where(eq(emailSends.campaignId, c.id))).toHaveLength(0);
  });
});

describe('approval threshold', () => {
  it('a Claude-made campaign to 51 contacts waits for approval; to 49 it is scheduled', async () => {
    const restore = await withSettings({ approval_threshold: 50 });
    try {
      const many = await Promise.all(Array.from({ length: 51 }, () => makeContact({ initialStatus: 'all' })));
      const c51 = await campaigns.create({ name: 'Claude 51', kind: 'manual', subject: 'Hello', segment: { contact_ids: many.map((m) => m.id) } }, 'claude');
      expect((await campaigns.schedule(c51.id, { actor: 'claude', now: WED })).status).toBe('pending_approval');
      const c49 = await campaigns.create({ name: 'Claude 49', kind: 'manual', subject: 'Hello', segment: { contact_ids: many.slice(0, 49).map((m) => m.id) } }, 'claude');
      expect((await campaigns.schedule(c49.id, { actor: 'claude', now: WED })).status).toBe('scheduled');
      // A person's campaign of any size is scheduled; Claude can never approve.
      const human = await campaigns.create({ name: 'Roger 51', kind: 'manual', subject: 'Hello', segment: { contact_ids: many.map((m) => m.id) } }, 'user-1');
      expect((await campaigns.schedule(human.id, { actor: 'user-1', now: WED })).status).toBe('scheduled');
      await expect(campaigns.approve(c51.id, 'claude')).rejects.toMatchObject({ code: 'forbidden' });
      expect((await campaigns.approve(c51.id, 'user-1')).status).toBe('scheduled');
    } finally {
      await restore();
    }
  });
});

describe('segments', () => {
  it('filters on each key', async () => {
    const now = WED;
    const a = await interested(['material:pla']);
    const b = await interested(['material:pla', 'material:petg']);
    const t = await makeContact({ initialStatus: 'transactional_only', isTrade: true });
    await getDb().update(emailContacts).set({ lastOrderAt: new Date(now.getTime() - 10 * DAY), lastClickAt: new Date(now.getTime() - 2 * DAY) }).where(eq(emailContacts.id, a.id));
    await getDb().update(emailContacts).set({ lastOrderAt: new Date(now.getTime() - 200 * DAY) }).where(eq(emailContacts.id, b.id));
    const ids = [a.id, b.id, t.id];
    const run = async (seg: Record<string, unknown>) => (await segmentContacts({ ...seg, contact_ids: ids }, now)).map((c) => c.id).sort();
    expect(await run({ status: 'all' })).toEqual([a.id, b.id].sort());
    expect(await run({ interests_any: ['material:petg'] })).toEqual([b.id]);
    expect(await run({ interests_all: ['material:pla', 'material:petg'] })).toEqual([b.id]);
    expect(await run({ is_trade: true })).toEqual([t.id]);
    expect(await run({ last_order_within_days: 30 })).toEqual([a.id]);
    expect(await run({ last_order_older_than_days: 90 })).toEqual([b.id]);
    expect(await run({ engaged_within_days: 7 })).toEqual([a.id]);
    expect(await run({ source: 'admin' })).toEqual(ids.sort());
    const c = await campaigns.create({ name: 'Earlier', kind: 'manual', subject: 's', segment: { contact_ids: [a.id] } }, 'user-1');
    await campaigns.schedule(c.id, { actor: 'user-1', now });
    await campaigns.expand(c.id, now);
    expect(await run({ exclude_campaign_ids: [c.id] })).toEqual([b.id, t.id].sort());
    await expect(segmentContacts({ nonsense: 1 })).rejects.toThrow();
  });
});
