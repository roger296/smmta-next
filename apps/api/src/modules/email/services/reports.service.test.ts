/**
 * Reports (runbook section 9): numbers on a seeded fixture match hand-worked
 * figures; a 50,000-send campaign reports in under 500 ms; the contact
 * timeline interleaves sends, consent changes and orders.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { getSingletonCompanyId } from '../../../shared/auth/company.js';
import { customerOrders, customers, emailCampaigns, emailEvents, emailSends } from '../../../db/schema/index.js';
import { CampaignsService } from './campaigns.service.js';
import { ContactsService } from './contacts.service.js';
import { ReportsService } from './reports.service.js';
import { cleanupFixtures, makeContact, makeContacts, makeCustomer, makeOrder, makeProduct } from '../testing.js';

const reports = new ReportsService();
const campaigns = new CampaignsService();
const COMPANY = getSingletonCompanyId();
const made: string[] = [];
const T = new Date('2031-06-03T09:00:00Z');

afterAll(async () => {
  await getDb().update(customerOrders).set({ emailCampaignId: null, emailSendId: null }).where(inArray(customerOrders.emailCampaignId, made));
  if (made.length) await getDb().delete(emailEvents).where(sql`${emailEvents.sendId} in (select id from email_sends where campaign_id in ${made})`);
  await getDb().delete(emailSends).where(inArray(emailSends.campaignId, made));
  await getDb().delete(emailCampaigns).where(inArray(emailCampaigns.id, made));
  await cleanupFixtures();
});

describe('campaignReport', () => {
  it('matches hand-worked figures', async () => {
    const people = await makeContacts(10);
    const c = await campaigns.create({ name: 'Report fixture', kind: 'manual', subject: 's' }, 'user-1');
    made.push(c.id);
    // 10 sends: 7 sent (5 delivered, 1 bounced, 1 complained), 2 dropped (never, invalid), 1 queued.
    // Of the delivered: 4 opened, 2 clicked. Variant A: sends 0–4, B: 5–9.
    const plan = [
      { status: 'clicked', sent: true, delivered: true, open: true, click: true },
      { status: 'clicked', sent: true, delivered: true, open: true, click: true },
      { status: 'opened', sent: true, delivered: true, open: true },
      { status: 'opened', sent: true, delivered: true, open: true },
      { status: 'delivered', sent: true, delivered: true },
      { status: 'bounced', sent: true },
      { status: 'complained', sent: true, delivered: true },
      { status: 'dropped', reason: 'never' },
      { status: 'dropped', reason: 'invalid' },
      { status: 'queued' },
    ] as const;
    const rows = await getDb()
      .insert(emailSends)
      .values(
        plan.map((p, i) => ({
          companyId: COMPANY,
          campaignId: c.id,
          contactId: people[i]!.id,
          class: 'marketing' as const,
          kind: 'manual',
          templateKey: 'manual',
          idempotencyKey: `rep:${c.id}:${i}`,
          status: p.status,
          variant: i < 5 ? 'A' : 'B',
          dropReason: 'reason' in p ? p.reason : null,
          sentAt: 'sent' in p ? T : null,
          deliveredAt: 'delivered' in p ? T : null,
          firstOpenAt: 'open' in p ? T : null,
          firstClickAt: 'click' in p ? T : null,
        })),
      )
      .returning();
    // Clicks on two links (one twice), with per-send tracking parameters.
    const click = (sendId: string, url: string, n: number) =>
      getDb().insert(emailEvents).values({ companyId: COMPANY, sendId, sgEventId: `rep-${sendId}-${n}`, event: 'click', payload: { url } });
    await click(rows[0]!.id, `https://shop.test/pla?utm_source=email&eid=${rows[0]!.id}`, 1);
    await click(rows[1]!.id, `https://shop.test/pla?utm_source=email&eid=${rows[1]!.id}`, 1);
    await click(rows[1]!.id, `https://shop.test/petg?utm_source=email&eid=${rows[1]!.id}`, 2);
    // One unsubscribe a day after the send; one order of £40 ex / £48 inc VAT.
    const contacts = new ContactsService();
    await contacts.setMarketingStatus(people[4]!.id, 'transactional_only', { source: 'one_click', actor: 'person' });
    await getDb().execute(sql`update email_sends set sent_at = now() - interval '1 day', delivered_at = now() - interval '1 day' where id = ${rows[4]!.id}`);
    const cust = await makeCustomer(null);
    const product = await makeProduct('Report PLA');
    const o = await makeOrder(cust.id, [{ productId: product.id, quantity: 2 }]);
    await getDb().update(customerOrders).set({ emailCampaignId: c.id, emailSendId: rows[0]!.id, orderTotal: '40.00', grandTotal: '48.00' }).where(eq(customerOrders.id, o.id));

    const r = await reports.campaignReport(c.id);
    expect(r).toMatchObject({
      total: 10,
      queued: 1,
      sent: 7,
      delivered: 6,
      bounced: 1,
      dropped: 2,
      opened: 4,
      clicked: 2,
      complained: 1,
      unsubscribesAfter: 1,
      orders: 1,
      revenueExVat: 40,
      revenueIncVat: 48,
      revenuePer1000: 5714.29, // £40 / 7 sent × 1,000
    });
    expect(r.droppedByReason).toEqual({ never: 1, invalid: 1 });
    expect(r.links).toEqual([
      { url: 'https://shop.test/pla', clicks: 2 },
      { url: 'https://shop.test/petg', clicks: 1 },
    ]);
    expect(r.ab).toEqual([
      { variant: 'A', sent: 5, clicked: 2, clickRate: 0.4 },
      { variant: 'B', sent: 2, clicked: 0, clickRate: 0 },
    ]);
    void customers;
  });

  it('reports a 50,000-send campaign in under 500 ms', async () => {
    const people = await makeContacts(1000);
    const c = await campaigns.create({ name: 'Report load', kind: 'manual', subject: 's' }, 'user-1');
    made.push(c.id);
    const ids = people.map((p) => p.id);
    await getDb().execute(sql`
      insert into email_sends (company_id, campaign_id, contact_id, class, kind, template_key, idempotency_key, status, sent_at, delivered_at, first_open_at, first_click_at)
      select ${COMPANY}, ${c.id}, (array[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])[1 + (g % 1000)], 'marketing', 'manual', 'manual', 'load:' || ${c.id} || ':' || g,
             (case when g % 10 = 0 then 'clicked' else 'delivered' end)::email_send_status,
             ${T}, ${T}, case when g % 3 = 0 then ${T}::timestamptz end, case when g % 10 = 0 then ${T}::timestamptz end
      from generate_series(1, 50000) g`);
    await getDb().execute(sql`analyze email_sends`);
    await reports.campaignReport(c.id); // warm
    const t0 = performance.now();
    const r = await reports.campaignReport(c.id);
    const ms = performance.now() - t0;
    expect(r.total).toBe(50000);
    expect(r.clicked).toBe(5000);
    expect(ms).toBeLessThan(500);
  });
});

describe('contactTimeline', () => {
  it('interleaves sends with their events, consent changes and orders, newest first', async () => {
    const contacts = new ContactsService();
    const cust = await makeCustomer(null);
    const c = await makeContact({ initialStatus: 'all', customerId: cust.id });
    await getDb().update(customers).set({ contactId: c.id }).where(eq(customers.id, cust.id));
    const [s] = await getDb()
      .insert(emailSends)
      .values({ companyId: COMPANY, contactId: c.id, class: 'marketing', kind: 'manual', templateKey: 'manual', idempotencyKey: `tl:${c.id}`, status: 'clicked', sentAt: new Date(Date.now() - 3 * 3_600_000) })
      .returning();
    await getDb().insert(emailEvents).values({ companyId: COMPANY, sendId: s!.id, sgEventId: `tl-${s!.id}`, event: 'click', payload: { url: 'https://shop.test/x' }, occurredAt: new Date(Date.now() - 2 * 3_600_000) });
    const product = await makeProduct('Timeline PLA');
    await makeOrder(cust.id, [{ productId: product.id, quantity: 1 }]);
    await contacts.setMarketingStatus(c.id, 'transactional_only', { source: 'link', actor: 'person' });
    const tl = await reports.contactTimeline(c.id);
    // Newest first: the unsubscribe, the order, the contact's creation, then
    // the send (dated three hours back).
    expect(tl.map((t) => t.type)).toEqual(['consent', 'order', 'consent', 'send']);
    const send = tl.find((t) => t.type === 'send')!;
    expect((send.detail.events as unknown[]).length).toBe(1);
    expect((await reports.contactTimeline(c.id, { limit: 2 })).length).toBe(2);
  });
});
