/**
 * A/B subject tests (runbook section 9): 1,000 contacts → 100 A, 100 B, then
 * 800 to the winner; under 200 contacts → A only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import { emailCampaigns, emailSends } from '../../../db/schema/index.js';
import { AbService } from './ab.service.js';
import { CampaignsService } from './campaigns.service.js';
import { cleanupFixtures, makeContacts } from '../testing.js';

const campaigns = new CampaignsService();
const ab = new AbService();
const T0 = new Date('2031-05-06T10:00:00Z');
const made: string[] = [];

afterAll(async () => {
  await cleanupFixtures();
  if (made.length) {
    await getDb().delete(emailSends).where(inArray(emailSends.campaignId, made));
    await getDb().update(emailCampaigns).set({ variantOf: null }).where(inArray(emailCampaigns.id, made));
    await getDb().delete(emailCampaigns).where(inArray(emailCampaigns.id, made));
  }
});

async function abCampaign(n: number) {
  const contacts = await makeContacts(n);
  const a = await campaigns.create({ name: `AB ${n}`, kind: 'manual', subject: 'Subject A', segment: { contact_ids: contacts.map((c) => c.id) } }, 'user-1');
  const b = await ab.createVariant(a.id, 'Subject B', 'user-1');
  made.push(a.id, b.id);
  await campaigns.schedule(a.id, { actor: 'user-1', scheduledAt: T0, now: T0 });
  return { a, b, contacts };
}

describe('A/B', () => {
  it('splits 1,000 contacts 100/100, then sends the winner to the other 800', async () => {
    const { a, b } = await abCampaign(1000);
    await campaigns.expandOrSplit(a.id, T0);
    const variants = async () =>
      Object.fromEntries(
        ((await getDb().execute(sql`select variant, count(*)::int as n from email_sends where campaign_id = ${a.id} group by variant`)).rows as Array<{ variant: string; n: number }>).map((r) => [r.variant, r.n]),
      );
    expect(await variants()).toEqual({ A: 100, B: 100 });
    const bRow = (await getDb().select().from(emailSends).where(and(eq(emailSends.campaignId, a.id), eq(emailSends.variant, 'B'))).limit(1))[0]!;
    expect((bRow.data as { subject: string }).subject).toBe('Subject B');

    // Both test groups go out; B gets more clicks.
    await getDb().update(emailSends).set({ status: 'sent', sentAt: T0 }).where(eq(emailSends.campaignId, a.id));
    const clicks = async (variant: string, n: number) => {
      const ids = (await getDb().select({ id: emailSends.id }).from(emailSends).where(and(eq(emailSends.campaignId, a.id), eq(emailSends.variant, variant))).limit(n)).map((r) => r.id);
      await getDb().update(emailSends).set({ status: 'clicked', firstClickAt: new Date(T0.getTime() + 600_000) }).where(inArray(emailSends.id, ids));
    };
    await clicks('A', 5);
    await clicks('B', 20);

    expect(await ab.decideDue(new Date(T0.getTime() + 3_600_000))).toBe(0); // not yet two hours
    expect(await ab.decideDue(new Date(T0.getTime() + 2 * 3_600_000))).toBe(1);
    expect(await variants()).toEqual({ A: 100, B: 900 });
    const [decided] = await getDb().select().from(emailCampaigns).where(eq(emailCampaigns.id, a.id));
    expect(decided).toMatchObject({ abWinner: 'B' });
    const queuedB = await getDb().select().from(emailSends).where(and(eq(emailSends.campaignId, a.id), eq(emailSends.status, 'queued')));
    expect(queuedB).toHaveLength(800);
    expect(queuedB.every((r) => r.variant === 'B' && (r.data as { subject: string }).subject === 'Subject B')).toBe(true);
    expect((await campaigns.get(b.id)).status).toBe('sent');
    expect(await ab.decideDue(new Date(T0.getTime() + 5 * 3_600_000))).toBe(0); // once
  });

  it('a tie goes to A', async () => {
    const { a } = await abCampaign(200);
    await campaigns.expandOrSplit(a.id, T0);
    await getDb().update(emailSends).set({ status: 'sent', sentAt: T0 }).where(eq(emailSends.campaignId, a.id));
    await ab.decideDue(new Date(T0.getTime() + 2 * 3_600_000));
    expect((await campaigns.get(a.id)).abWinner).toBe('A');
  });

  it('an audience under 200 gets A only', async () => {
    const { a, b } = await abCampaign(150);
    await campaigns.expandOrSplit(a.id, T0);
    const rows = await getDb().select().from(emailSends).where(eq(emailSends.campaignId, a.id));
    expect(rows).toHaveLength(150);
    expect(rows.every((r) => r.variant === null)).toBe(true);
    expect((await campaigns.get(b.id)).status).toBe('cancelled');
    expect((await campaigns.get(a.id)).abWinner).toBe('A');
    void isNull;
  });
});
