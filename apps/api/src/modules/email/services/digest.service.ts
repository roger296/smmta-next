/**
 * The weekly digest and the daily new-product roll-up (spec § Campaign types;
 * runbook section 8).
 *
 * Weekly digest: drafted Wednesday 10:00 UK and scheduled for Thursday 10:00
 * over 180 minutes. Each contact's email is built from blocks, in order —
 * new products in their interests since their last digest; their interests
 * back in stock; this week's deals in their interests; this week's featured
 * paragraph for each of their materials; and, for a contact with no
 * interests yet, the shop-wide new-in and best-sellers. A contact with
 * nothing to show gets no email (it is a cap, not a target), and their
 * `last_digest_at` still moves on.
 *
 * New-product roll-up: daily 11:00 UK. Everything added in the last 24 hours,
 * in one email per contact, only what matches their interests; skipped for
 * contacts whose digest is due within 48 hours (it will carry it) and, by the
 * gate, those inside the 7-day marketing gap — unless a hero product is in
 * the run.
 */
import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import {
  emailCampaigns,
  emailContacts,
  emailWeeklyContent,
  orderLines,
  customerOrders,
  productGroups,
  products,
  stockItems,
} from '../../../db/schema/index.js';
import { interestKeysForProduct, interestedKeys, materialName, MATERIAL_KEYS } from '../lib/interests.js';
import { localMinutes, nextLocalTime } from '../lib/gate.js';
import type { EmailSettings } from '../lib/settings-defaults.js';
import type { Block, ProductCard } from '../templates/blocks.js';
import { policyFrom } from './audience.service.js';
import {
  CampaignsService,
  registerAfterExpand,
  registerContentBuilder,
  type Campaign,
  type ContactContent,
} from './campaigns.service.js';
import type { Contact } from './contacts.service.js';
import { getEmailSettings } from './settings.service.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** The UK calendar date (YYYY-MM-DD) and weekday (0 = Sunday) of an instant. */
export function ukDate(now: Date): { date: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { date: `${get('year')}-${get('month')}-${get('day')}`, weekday };
}

/** Monday of the UK week `now` falls in. */
export function weekStartOf(now: Date): string {
  const { date, weekday } = ukDate(now);
  const back = (weekday + 6) % 7;
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** The next moment that is `weekday` at `hhmm` UK time, after `now`. */
export function nextWeekdayAt(now: Date, weekday: number, hhmm: string): Date {
  let t = nextLocalTime(now, hhmm, 'Europe/London');
  for (let i = 0; i < 8 && ukDate(t).weekday !== weekday; i++) t = nextLocalTime(new Date(t.getTime() + 60_000), hhmm, 'Europe/London');
  return t;
}

interface CatalogueRow extends ProductCard {
  createdAt: Date;
  hero: boolean;
}

/** Published products as cards, with their interest keys. */
async function productCards(where: ReturnType<typeof and>, limit = 500): Promise<CatalogueRow[]> {
  const rows = await getDb()
    .select({
      id: products.id,
      name: products.name,
      colour: products.colour,
      slug: products.slug,
      imageUrl: products.heroImageUrl,
      price: products.minSellingPrice,
      categoryId: products.categoryId,
      createdAt: products.createdAt,
      hero: products.hero,
      groupName: productGroups.name,
      groupSlug: productGroups.slug,
    })
    .from(products)
    .leftJoin(productGroups, eq(products.groupId, productGroups.id))
    .where(and(eq(products.isPublished, true), isNull(products.deletedAt), where))
    .orderBy(desc(products.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    productId: r.id,
    name: r.groupName ?? r.name,
    colour: r.colour,
    imageUrl: r.imageUrl,
    priceGbp: r.price,
    groupSlug: r.groupSlug,
    slug: r.slug,
    interestKeys: interestKeysForProduct({ name: r.name, groupName: r.groupName, categoryId: r.categoryId }),
    createdAt: r.createdAt,
    hero: r.hero,
  }));
}

const matches = (card: ProductCard, keys: string[]) => (card.interestKeys ?? []).some((k) => keys.includes(k));
const label = (keys: string[]) => {
  const names = keys.map((k) => materialName(k)).filter(Boolean) as string[];
  return names.length ? names.slice(0, 3).join(', ') : 'your interests';
};

export class DigestService {
  private campaigns = new CampaignsService();

  /** Per-contact digest blocks; null when there is nothing to show. */
  async buildFor(contacts: Contact[], now: Date, settingsIn?: EmailSettings): Promise<Map<string, ContactContent>> {
    const settings = settingsIn ?? (await getEmailSettings());
    const policy = policyFrom(settings);
    const out = new Map<string, ContactContent>();
    if (contacts.length === 0) return out;
    const db = getDb();
    const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
    const earliest = contacts.reduce((m, c) => (c.lastDigestAt && c.lastDigestAt < m ? c.lastDigestAt : m), weekAgo);

    const fresh = await productCards(gte(products.createdAt, earliest));
    // Back in stock: older products with stock booked in this week.
    const restockedIds = (
      await db
        .selectDistinct({ id: stockItems.productId })
        .from(stockItems)
        .where(and(eq(stockItems.status, 'IN_STOCK'), gte(stockItems.createdAt, weekAgo), isNull(stockItems.deletedAt)))
    ).map((r) => r.id);
    const restocked = restockedIds.length
      ? await productCards(and(inArray(products.id, restockedIds), lt(products.createdAt, weekAgo)))
      : [];
    const week = weekStartOf(now);
    const weekly = await db.select().from(emailWeeklyContent).where(eq(emailWeeklyContent.weekStart, week));
    const deals = weekly.filter((w) => w.kind === 'deal');
    const featured = weekly.filter((w) => w.kind === 'featured');
    const bestIds = (
      await db
        .select({ id: orderLines.productId, n: sql<number>`sum(${orderLines.quantity})` })
        .from(orderLines)
        .innerJoin(customerOrders, eq(orderLines.orderId, customerOrders.id))
        .where(and(gte(customerOrders.createdAt, new Date(now.getTime() - 30 * DAY_MS)), sql`${customerOrders.status} <> 'CANCELLED'`))
        .groupBy(orderLines.productId)
        .orderBy(desc(sql`sum(${orderLines.quantity})`))
        .limit(6)
    ).map((r) => r.id);
    const best = bestIds.length ? await productCards(inArray(products.id, bestIds)) : [];

    for (const c of contacts) {
      const keys = interestedKeys(c.interests, now, policy);
      const since = c.lastDigestAt ?? weekAgo;
      const blocks: Block[] = [];
      if (keys.length) {
        const newIn = fresh.filter((p) => p.createdAt >= since && matches(p, keys)).slice(0, 6);
        if (newIn.length) blocks.push({ type: 'ProductGrid', props: { title: `New in ${label(keys)}`, products: newIn, cta: 'view' } });
        const back = restocked.filter((p) => matches(p, keys)).slice(0, 4);
        if (back.length) blocks.push({ type: 'ProductGrid', props: { title: 'Back in stock', products: back, cta: 'add' } });
        const myDeals = deals.filter((d) => d.key === 'all' || keys.includes(d.key));
        if (myDeals.length) {
          blocks.push({
            type: 'DealsList',
            props: { deals: myDeals.map((d) => ({ title: d.title ?? d.body, description: d.title ? d.body : undefined, url: d.url ?? undefined, priceGbp: d.priceGbp ?? undefined, savingGbp: d.savingGbp ?? undefined })) },
          });
        }
        // The featured paragraph rides along with real news; on its own it
        // is not a reason to email someone.
        if (blocks.length) {
          for (const f of featured.filter((f) => keys.includes(f.key) || f.key === 'all').slice(0, 2)) {
            blocks.push({ type: 'FeaturedText', props: { heading: f.title ?? undefined, markdown: f.body } });
          }
        }
      } else {
        const newIn = fresh.filter((p) => p.createdAt >= since).slice(0, 6);
        if (newIn.length) blocks.push({ type: 'ProductGrid', props: { title: 'New in this week', products: newIn, cta: 'view' } });
        if (newIn.length && best.length) blocks.push({ type: 'ProductGrid', props: { title: 'Best-sellers', products: best, cta: 'view' } });
      }
      out.set(c.id, blocks.length ? { blocks } : null);
    }
    return out;
  }

  /** Wednesday: the week's digest campaign, scheduled for Thursday. Once per week. */
  async createWeeklyDigest(now = new Date()): Promise<Campaign> {
    const settings = await getEmailSettings();
    const sendAt = nextWeekdayAt(now, settings.digest.send_day, settings.digest.send_time);
    const tag = `digest-${ukDate(sendAt).date}`;
    const [existing] = await getDb().select().from(emailCampaigns).where(and(eq(emailCampaigns.kind, 'weekly_digest'), eq(emailCampaigns.utmCampaign, tag)));
    // A digest left in draft (scheduling failed last time) is scheduled now.
    if (existing?.status === 'draft') return this.campaigns.schedule(existing.id, { scheduledAt: sendAt, actor: 'system', now });
    if (existing) return existing;
    const created = await this.campaigns.create(
      {
        name: `Weekly digest ${ukDate(sendAt).date}`,
        kind: 'weekly_digest',
        segment: { status: 'all' },
        templateKey: 'weekly_digest',
        scheduledAt: sendAt,
        sendWindowMinutes: settings.digest.window_minutes,
        utmCampaign: tag,
      },
      'system',
    );
    return this.campaigns.schedule(created.id, { scheduledAt: sendAt, actor: 'system', now });
  }

  /** When the next digest goes, for the 48-hour rule. */
  async nextDigestAt(now: Date, settings: EmailSettings): Promise<Date> {
    const [scheduled] = await getDb()
      .select({ at: emailCampaigns.scheduledAt })
      .from(emailCampaigns)
      .where(and(eq(emailCampaigns.kind, 'weekly_digest'), inArray(emailCampaigns.status, ['scheduled', 'pending_approval']), gte(emailCampaigns.scheduledAt, now)))
      .orderBy(emailCampaigns.scheduledAt)
      .limit(1);
    return scheduled?.at ?? nextWeekdayAt(now, settings.digest.send_day, settings.digest.send_time);
  }

  /** Daily: one new-product campaign for everything added in 24 hours. */
  async createNewProductRollup(now = new Date()): Promise<Campaign | null> {
    const added = await productCards(gte(products.createdAt, new Date(now.getTime() - DAY_MS)));
    if (added.length === 0) return null;
    const tag = `new-${ukDate(now).date}`;
    const [existing] = await getDb().select().from(emailCampaigns).where(and(eq(emailCampaigns.kind, 'new_product'), eq(emailCampaigns.utmCampaign, tag)));
    if (existing?.status === 'draft') return this.campaigns.schedule(existing.id, { scheduledAt: now, actor: 'system', now });
    if (existing) return existing;
    const created = await this.campaigns.create(
      {
        name: `New products ${ukDate(now).date}`,
        kind: 'new_product',
        segment: { status: 'all' },
        templateKey: 'new_product_alert',
        scheduledAt: now,
        sendWindowMinutes: 60,
        overrideGap: added.some((p) => p.hero),
        utmCampaign: tag,
      },
      'system',
    );
    return this.campaigns.schedule(created.id, { scheduledAt: now, actor: 'system', now });
  }

  async buildNewProductFor(campaign: Campaign, contacts: Contact[], now: Date): Promise<Map<string, ContactContent>> {
    const settings = await getEmailSettings();
    const policy = policyFrom(settings);
    const out = new Map<string, ContactContent>();
    const since = new Date((campaign.scheduledAt ?? now).getTime() - DAY_MS);
    const added = await productCards(gte(products.createdAt, since));
    const digestDue = (await this.nextDigestAt(now, settings)).getTime() - now.getTime() < settings.digest_due_skip_hours * HOUR_MS;
    for (const c of contacts) {
      if (digestDue) {
        out.set(c.id, null);
        continue;
      }
      const keys = interestedKeys(c.interests, now, policy);
      const mine = added.filter((p) => matches(p, keys)).slice(0, 6);
      if (mine.length === 0) {
        out.set(c.id, null);
        continue;
      }
      const material = MATERIAL_KEYS.find((k) => mine.some((p) => p.interestKeys?.includes(k)));
      out.set(c.id, {
        blocks: [{ type: 'ProductGrid', props: { title: material ? `New in ${materialName(material)}` : 'New in', products: mine, cta: 'view' } }],
        data: { material },
      });
    }
    return out;
  }
}

const digest = new DigestService();

registerContentBuilder('weekly_digest', (_c, contacts, now) => digest.buildFor(contacts, now));
registerContentBuilder('new_product', (c, contacts, now) => digest.buildNewProductFor(c, contacts, now));
// Everyone considered for a digest has their window moved on, sent or not.
registerAfterExpand('weekly_digest', async (_c, considered, now) => {
  const ids = considered.map((c) => c.id);
  for (let i = 0; i < ids.length; i += 5000) {
    await getDb().update(emailContacts).set({ lastDigestAt: now }).where(inArray(emailContacts.id, ids.slice(i, i + 5000)));
  }
});

/** True once `now` is at or past `hhmm` UK time on `weekday` (any day when
 *  weekday is null). The 15-minute jobs use it so the times can be changed
 *  in settings without touching the schedule. */
export function reached(now: Date, weekday: number | null, hhmm: string): boolean {
  if (weekday !== null && ukDate(now).weekday !== weekday) return false;
  return localMinutes(now, 'Europe/London') >= Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}
