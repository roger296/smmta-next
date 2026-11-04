/**
 * Automations (spec § Sales-maximising improvements; runbook section 12).
 * One worker job, `email-automations`, runs every 15 minutes and asks each
 * switched-on automation for the sends now due. Every candidate carries an
 * idempotency key naming its step (`replenish:<line>:1`, `cart:<cart>:2`,
 * …), so evaluating again never sends twice, and every send goes through the
 * gate like any other.
 *
 * Safety: a step is only due within a short catch-up window after its time
 * (3 days; a day for baskets), so switching an automation on does not mail
 * everyone whose moment passed months ago.
 *
 *  replenishment  last order of a material + 85% of its expected life (the
 *                 per-material default × quantity, or the contact's own median
 *                 reorder interval once there are two orders); a second
 *                 reminder 10 days later if no order since. Marketing.
 *  abandoned_cart a basket reported at checkout with no order: 1 h, 24 h and
 *                 (only when a discount is allowed) 72 h. Marketing.
 *  welcome        a newsletter signup: day 0, 3, 10; skipped once they order.
 *  post_purchase  delivery + 7 days printing tips, + 14 days review request.
 *                 Service class: no offers, reaches transactional-only too.
 *  winback        120 and 240 days after the last order, addresses
 *                 re-verified first. Marketing.
 *  subscription   "anything to add to your next box?" 7 days before renewal.
 *  price_drop     a product in someone's interests fell 10% or more, or is
 *                 nearly sold out; at most one a week per person.
 *
 * Not built as automations, on purpose (BUILD_LOG section 12): pre-order and
 * subscription renewal notices, which the existing notification agent
 * already sends; and the trade digest, which is the weekly digest showing
 * trade prices to trade contacts.
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import {
  customerOrders,
  customers,
  emailCarts,
  emailContacts,
  emailMaterialContent,
  emailPriceSnapshots,
  emailSends,
  orderLines,
  productGroups,
  products,
  stockItems,
  storefrontUsers,
  subscriptions,
  type EmailClass,
} from '../../../db/schema/index.js';
import { interestKeysForProduct, isInterested, materialName, MATERIAL_KEYS } from '../lib/interests.js';
import type { EmailSettings } from '../lib/settings-defaults.js';
import type { Block, ProductCard } from '../templates/blocks.js';
import { policyFrom } from './audience.service.js';
import { ContactsService } from './contacts.service.js';
import { SendsService } from './sends.service.js';
import { getEmailSettings } from './settings.service.js';
import { VerificationService } from './verification.service.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const CATCH_UP_MS = 3 * DAY_MS;

export interface Candidate {
  contactId: string;
  class: EmailClass;
  kind: string;
  templateKey: string;
  idempotencyKey: string;
  data: Record<string, unknown>;
}

export interface AutomationModule {
  key: string;
  evaluate(now: Date, settings: EmailSettings): Promise<Candidate[]>;
}

const due = (at: Date, now: Date, window = CATCH_UP_MS) => now >= at && now.getTime() - at.getTime() <= window;
const cfg = (s: EmailSettings, key: string) => s.automations[key]!;
const numList = (v: unknown) => String(v ?? '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));

async function cards(productIds: string[]): Promise<Map<string, ProductCard>> {
  if (productIds.length === 0) return new Map();
  const rows = await getDb()
    .select({ id: products.id, name: products.name, colour: products.colour, slug: products.slug, imageUrl: products.heroImageUrl, price: products.minSellingPrice, categoryId: products.categoryId, groupName: productGroups.name, groupSlug: productGroups.slug })
    .from(products)
    .leftJoin(productGroups, eq(products.groupId, productGroups.id))
    .where(inArray(products.id, productIds));
  return new Map(
    rows.map((r) => [
      r.id,
      { productId: r.id, name: r.groupName ?? r.name, colour: r.colour, imageUrl: r.imageUrl, priceGbp: r.price, groupSlug: r.groupSlug, slug: r.slug, interestKeys: interestKeysForProduct({ name: r.name, groupName: r.groupName, categoryId: r.categoryId }) },
    ]),
  );
}

async function freeStock(productIds: string[]): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map();
  const rows = await getDb()
    .select({ id: stockItems.productId, n: sql<number>`count(*)::int` })
    .from(stockItems)
    .where(and(inArray(stockItems.productId, productIds), eq(stockItems.status, 'IN_STOCK'), isNull(stockItems.deletedAt)))
    .groupBy(stockItems.productId);
  return new Map(rows.map((r) => [r.id, r.n]));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// ---------------------------------------------------------------------------

export const replenishment: AutomationModule = {
  key: 'replenishment',
  async evaluate(now, s) {
    const c = cfg(s, 'replenishment');
    const rows = await getDb()
      .select({
        lineId: orderLines.id,
        productId: orderLines.productId,
        quantity: orderLines.quantity,
        orderDate: customerOrders.orderDate,
        contactId: customers.contactId,
        name: products.name,
        groupName: productGroups.name,
      })
      .from(orderLines)
      .innerJoin(customerOrders, eq(orderLines.orderId, customerOrders.id))
      .innerJoin(customers, eq(customerOrders.customerId, customers.id))
      .innerJoin(products, eq(orderLines.productId, products.id))
      .leftJoin(productGroups, eq(products.groupId, productGroups.id))
      .where(and(isNotNull(customers.contactId), isNull(customerOrders.deletedAt), sql`${customerOrders.status} <> 'CANCELLED'`, gte(customerOrders.orderDate, new Date(now.getTime() - 400 * DAY_MS).toISOString().slice(0, 10))))
      .orderBy(customerOrders.orderDate);

    // Group by (contact, material); the latest line of each is the one to remind about.
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const material = interestKeysForProduct(r).find((k) => k.startsWith('material:'));
      if (!material) continue;
      const k = `${r.contactId}|${material}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const out: Candidate[] = [];
    const latest = [...groups.entries()].map(([k, lines]) => ({ material: k.split('|')[1]!, line: lines.at(-1)!, lines }));
    const productCards = await cards([...new Set(latest.map((l) => l.line.productId))]);
    const firstSends = await getDb()
      .select({ key: emailSends.idempotencyKey, sentAt: emailSends.sentAt })
      .from(emailSends)
      .where(and(eq(emailSends.kind, 'replenishment'), sql`${emailSends.idempotencyKey} like 'replenish:%:1'`));
    const sentAt = new Map(firstSends.map((f) => [f.key, f.sentAt]));

    for (const { material, line, lines } of latest) {
      const dates = [...new Set(lines.map((l) => l.orderDate))].sort();
      let lifeDays = (s.replenishment_days[material] ?? s.replenishment_days.default ?? 49) * Math.max(1, Math.round(Number(line.quantity)));
      if (dates.length >= 2) {
        const gaps = dates.slice(1).map((d, i) => (Date.parse(d) - Date.parse(dates[i]!)) / DAY_MS);
        lifeDays = median(gaps);
      }
      const ordered = new Date(`${line.orderDate}T09:00:00Z`);
      const first = new Date(ordered.getTime() + Number(c.at_fraction) * lifeDays * DAY_MS);
      const card = productCards.get(line.productId);
      const data = { material, blocks: card ? ([{ type: 'ProductGrid', props: { products: [card], cta: 'add' } }] as Block[]) : [] };
      const key1 = `replenish:${line.lineId}:1`;
      if (due(first, now)) out.push({ contactId: line.contactId!, class: 'marketing', kind: 'replenishment', templateKey: 'replenishment_1', idempotencyKey: key1, data });
      const s1 = sentAt.get(key1);
      if (s1) {
        const second = new Date(s1.getTime() + Number(c.follow_up_days) * DAY_MS);
        if (due(second, now)) out.push({ contactId: line.contactId!, class: 'marketing', kind: 'replenishment', templateKey: 'replenishment_2', idempotencyKey: `replenish:${line.lineId}:2`, data });
      }
    }
    return out;
  },
};

export const abandonedCart: AutomationModule = {
  key: 'abandoned_cart',
  async evaluate(now, s) {
    const c = cfg(s, 'abandoned_cart');
    const steps = numList(c.step_hours);
    const db = getDb();
    const carts = await db
      .select({ cart: emailCarts, lastOrderAt: emailContacts.lastOrderAt })
      .from(emailCarts)
      .innerJoin(emailContacts, eq(emailCarts.contactId, emailContacts.id))
      .where(and(isNull(emailCarts.orderedAt), gte(emailCarts.updatedAt, new Date(now.getTime() - ((steps.at(-1) ?? 72) + 24) * HOUR_MS))));
    const out: Candidate[] = [];
    const ids = [...new Set(carts.flatMap((r) => r.cart.lines.map((l) => l.productId)))];
    const productCards = await cards(ids);
    const stock = await freeStock(ids);
    for (const { cart, lastOrderAt } of carts) {
      // Ordered since: the sequence stops.
      if (lastOrderAt && lastOrderAt >= cart.updatedAt) {
        await db.update(emailCarts).set({ orderedAt: lastOrderAt }).where(eq(emailCarts.id, cart.id));
        continue;
      }
      if (cart.lines.length === 0) continue;
      steps.forEach((h, i) => {
        const step = i + 1;
        if (step === 3 && !c.discount_allowed) return;
        if (!due(new Date(cart.updatedAt.getTime() + h * HOUR_MS), now, DAY_MS)) return;
        const lines = cart.lines.map((l) => {
          const p = productCards.get(l.productId);
          return { productId: l.productId, name: p?.name ?? 'Your item', colour: p?.colour, imageUrl: p?.imageUrl, quantity: l.quantity, priceGbp: l.priceGbp ?? p?.priceGbp };
        });
        const low = cart.lines.map((l) => ({ l, n: stock.get(l.productId) ?? 0 })).find((x) => x.n > 0 && x.n < 5);
        const blocks: Block[] = [{ type: 'CartContents', props: { lines, stockNote: step >= 2 && low ? `Only ${low.n} left of ${productCards.get(low.l.productId)?.name ?? 'one of these'}.` : undefined } }];
        if (step === 3 && c.discount_code) blocks.push({ type: 'Text', props: { body: `Use code ${String(c.discount_code)} at checkout.` } });
        out.push({ contactId: cart.contactId, class: 'marketing', kind: 'abandoned_cart', templateKey: `abandoned_cart_${step}`, idempotencyKey: `cart:${cart.id}:${step}`, data: { blocks } });
      });
    }
    return out;
  },
};

export const welcome: AutomationModule = {
  key: 'welcome',
  async evaluate(now, s) {
    const c = cfg(s, 'welcome');
    const days = numList(c.step_days);
    const policy = policyFrom(s);
    const rows = await getDb()
      .select()
      .from(emailContacts)
      .where(and(eq(emailContacts.consentSource, 'signup_form'), eq(emailContacts.marketingStatus, 'all'), isNull(emailContacts.lastOrderAt), gte(emailContacts.consentAt, new Date(now.getTime() - ((days.at(-1) ?? 10) + 3) * DAY_MS))));
    const best = await bestSellers(now, 12);
    const out: Candidate[] = [];
    for (const contact of rows) {
      days.forEach((d, i) => {
        const step = i + 1;
        if (!due(new Date(contact.consentAt!.getTime() + d * DAY_MS), now)) return;
        const material = MATERIAL_KEYS.find((k) => isInterested(contact.interests, k, now, policy));
        const picks = best.filter((b) => !material || b.interestKeys?.includes(material)).slice(0, 4);
        const blocks: Block[] = step === 1 ? [] : [{ type: 'ProductGrid', props: { title: material ? `Best-sellers in ${materialName(material)}` : 'Best-sellers', products: picks.length ? picks : best.slice(0, 4), cta: 'view' } }];
        if (step === 3 && c.discount_allowed && c.discount_code) blocks.push({ type: 'Text', props: { body: `Use code ${String(c.discount_code)} on your first order.` } });
        out.push({ contactId: contact.id, class: 'marketing', kind: 'welcome', templateKey: `welcome_${step}`, idempotencyKey: `welcome:${contact.id}:${step}`, data: { material, ...(blocks.length ? { blocks } : {}) } });
      });
    }
    return out;
  },
};

async function bestSellers(now: Date, limit: number): Promise<ProductCard[]> {
  const ids = (
    await getDb()
      .select({ id: orderLines.productId })
      .from(orderLines)
      .innerJoin(customerOrders, eq(orderLines.orderId, customerOrders.id))
      .where(and(gte(customerOrders.createdAt, new Date(now.getTime() - 60 * DAY_MS)), sql`${customerOrders.status} <> 'CANCELLED'`))
      .groupBy(orderLines.productId)
      .orderBy(desc(sql`sum(${orderLines.quantity})`))
      .limit(limit)
  ).map((r) => r.id);
  const m = await cards(ids);
  return ids.map((id) => m.get(id)).filter(Boolean) as ProductCard[];
}

export const postPurchase: AutomationModule = {
  key: 'post_purchase',
  async evaluate(now, s) {
    const c = cfg(s, 'post_purchase');
    const db = getDb();
    const since = new Date(now.getTime() - 40 * DAY_MS).toISOString().slice(0, 10);
    const orders = await db
      .select({ id: customerOrders.id, shipped: customerOrders.shippedDate, delivered: customerOrders.deliveryDate, contactId: customers.contactId })
      .from(customerOrders)
      .innerJoin(customers, eq(customerOrders.customerId, customers.id))
      .where(and(isNotNull(customers.contactId), isNotNull(customerOrders.shippedDate), gte(customerOrders.shippedDate, since), isNull(customerOrders.deletedAt)));
    const tips = new Map((await db.select().from(emailMaterialContent)).map((t) => [t.key, t.markdown]));
    const out: Candidate[] = [];
    for (const o of orders) {
      const deliveredAt = o.delivered ? new Date(`${o.delivered}T12:00:00Z`) : new Date(Date.parse(`${o.shipped}T12:00:00Z`) + 2 * DAY_MS);
      const lines = await db
        .select({ productId: orderLines.productId, name: products.name, groupName: productGroups.name })
        .from(orderLines)
        .innerJoin(products, eq(orderLines.productId, products.id))
        .leftJoin(productGroups, eq(products.groupId, productGroups.id))
        .where(eq(orderLines.orderId, o.id));
      const material = lines.flatMap((l) => interestKeysForProduct(l)).find((k) => k.startsWith('material:'));
      if (due(new Date(deliveredAt.getTime() + Number(c.tips_days) * DAY_MS), now) && material && tips.get(material)) {
        out.push({ contactId: o.contactId!, class: 'service', kind: 'post_purchase', templateKey: 'post_purchase_tips', idempotencyKey: `post:${o.id}:tips`, data: { material, blocks: [{ type: 'FeaturedText', props: { heading: `Printing with ${materialName(material)}`, markdown: tips.get(material)! } }] } });
      }
      if (due(new Date(deliveredAt.getTime() + Number(c.review_days) * DAY_MS), now)) {
        const card = (await cards(lines.slice(0, 1).map((l) => l.productId))).get(lines[0]?.productId ?? '');
        const blocks: Block[] = [{ type: 'Text', props: { body: 'We would be glad to hear how your order printed. A short review helps other makers choose, and tells us what to stock next.' } }];
        if (card) blocks.push({ type: 'ProductGrid', props: { title: 'Review it here', products: [card], cta: 'view' } });
        out.push({ contactId: o.contactId!, class: 'service', kind: 'post_purchase', templateKey: 'review_request', idempotencyKey: `post:${o.id}:review`, data: { blocks } });
      }
    }
    return out;
  },
};

export const winback: AutomationModule = {
  key: 'winback',
  async evaluate(now, s) {
    const c = cfg(s, 'winback');
    const policy = policyFrom(s);
    const best = await bestSellers(now, 12);
    const out: Candidate[] = [];
    for (const [step, days] of [[1, Number(c.first_days)], [2, Number(c.second_days)]] as const) {
      const from = new Date(now.getTime() - (days + 3) * DAY_MS);
      const to = new Date(now.getTime() - days * DAY_MS);
      const rows = await getDb()
        .select()
        .from(emailContacts)
        .where(and(eq(emailContacts.marketingStatus, 'all'), gte(emailContacts.lastOrderAt, from), lte(emailContacts.lastOrderAt, to)));
      for (const contact of rows) {
        const material = MATERIAL_KEYS.find((k) => isInterested(contact.interests, k, now, policy));
        const since = await getDb()
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.isPublished, true), gte(products.createdAt, contact.lastOrderAt!)))
          .limit(50);
        const fresh = [...(await cards(since.map((p) => p.id))).values()].filter((p) => !material || p.interestKeys?.includes(material)).slice(0, 4);
        const blocks: Block[] = [{ type: 'ProductGrid', props: { title: fresh.length ? 'New since you last visited' : 'Our best-sellers', products: fresh.length ? fresh : best.slice(0, 4), cta: 'view' } }];
        if (step === 2 && c.discount_allowed && c.discount_code) blocks.push({ type: 'Text', props: { body: `Use code ${String(c.discount_code)} on your next order.` } });
        out.push({ contactId: contact.id, class: 'marketing', kind: 'winback', templateKey: `winback_${step}`, idempotencyKey: `winback:${contact.id}:${contact.lastOrderAt!.toISOString().slice(0, 10)}:${step}`, data: { blocks } });
      }
    }
    return out;
  },
};

export const subscriptionAdd: AutomationModule = {
  key: 'subscription',
  async evaluate(now, s) {
    const c = cfg(s, 'subscription');
    const at = new Date(now.getTime() + Number(c.add_days) * DAY_MS);
    const rows = await getDb()
      .select({ id: subscriptions.id, renewsAt: subscriptions.renewsAt, email: storefrontUsers.email })
      .from(subscriptions)
      .innerJoin(storefrontUsers, eq(subscriptions.userId, storefrontUsers.id))
      .where(and(eq(subscriptions.status, 'active'), gte(subscriptions.renewsAt, new Date(at.getTime() - DAY_MS)), lte(subscriptions.renewsAt, at)));
    const out: Candidate[] = [];
    const contacts = new ContactsService();
    const best = await bestSellers(now, 4);
    for (const r of rows) {
      if (!r.email) continue;
      const contact = await contacts.getByEmail(r.email);
      if (!contact) continue;
      out.push({ contactId: contact.id, class: 'marketing', kind: 'subscription', templateKey: 'subscription_add', idempotencyKey: `sub-add:${r.id}:${r.renewsAt!.toISOString().slice(0, 10)}`, data: { blocks: [{ type: 'ProductGrid', props: { title: 'Popular this month', products: best, cta: 'view' } }] } });
    }
    return out;
  },
};

export const priceDrop: AutomationModule = {
  key: 'price_drop',
  async evaluate(now, s) {
    const c = cfg(s, 'price_drop');
    const db = getDb();
    const policy = policyFrom(s);
    const current = await db.select({ id: products.id, price: products.minSellingPrice }).from(products).where(and(eq(products.isPublished, true), isNotNull(products.minSellingPrice)));
    const seen = new Map((await db.select().from(emailPriceSnapshots)).map((r) => [r.productId, Number(r.priceGbp)]));
    const dropped = current.filter((p) => seen.has(p.id) && Number(p.price) <= seen.get(p.id)! * (1 - Number(c.drop_fraction))).map((p) => p.id);
    // Remember every price for next time (first sight records, never sends).
    for (let i = 0; i < current.length; i += 500) {
      const batch = current.slice(i, i + 500).map((p) => ({ productId: p.id, priceGbp: String(p.price), seenAt: now }));
      await db.insert(emailPriceSnapshots).values(batch).onConflictDoUpdate({ target: emailPriceSnapshots.productId, set: { priceGbp: sql`excluded.price_gbp`, seenAt: now } });
    }
    const stock = await freeStock(current.map((p) => p.id));
    const lowIds = current.filter((p) => {
      const n = stock.get(p.id) ?? 0;
      return n > 0 && n < Number(c.low_stock);
    }).map((p) => p.id);
    const all = await cards([...new Set([...dropped, ...lowIds])]);
    if (all.size === 0) return [];
    const contacts = await db.select().from(emailContacts).where(and(eq(emailContacts.marketingStatus, 'all'), sql`${emailContacts.interests} <> '{}'::jsonb`));
    const week = `${now.getUTCFullYear()}-w${Math.floor((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 1)) / (7 * DAY_MS))}`;
    const out: Candidate[] = [];
    for (const contact of contacts) {
      const mine = [...all.values()].filter((p) => (p.interestKeys ?? []).some((k) => isInterested(contact.interests, k, now, policy)));
      if (mine.length === 0) continue;
      const drops = mine.filter((p) => dropped.includes(p.productId)).slice(0, 4);
      const lows = mine.filter((p) => lowIds.includes(p.productId) && !dropped.includes(p.productId)).slice(0, 4 - drops.length);
      const blocks: Block[] = [];
      if (drops.length) blocks.push({ type: 'ProductGrid', props: { title: 'Price dropped', products: drops, cta: 'add' } });
      if (lows.length) blocks.push({ type: 'ProductGrid', props: { title: 'Nearly sold out', products: lows, cta: 'add' } });
      out.push({ contactId: contact.id, class: 'marketing', kind: 'price_drop', templateKey: 'price_drop', idempotencyKey: `price:${contact.id}:${week}`, data: { blocks, ...(drops.length ? {} : { subject: 'Nearly sold out: something you like' }) } });
    }
    return out;
  },
};

export const AUTOMATIONS: AutomationModule[] = [replenishment, abandonedCart, welcome, postPurchase, winback, subscriptionAdd, priceDrop];

export interface AutomationRun {
  key: string;
  enabled: boolean;
  candidates: number;
  queued: number;
  dropped: number;
}

/** The `email-automations` job. `only` limits the run (tests, dry counts). */
export async function runAutomations(now = new Date(), opts: { only?: string[]; countOnly?: boolean; ignoreSwitches?: boolean } = {}): Promise<AutomationRun[]> {
  const settings = await getEmailSettings();
  const sends = new SendsService();
  const out: AutomationRun[] = [];
  for (const m of AUTOMATIONS) {
    if (opts.only && !opts.only.includes(m.key)) continue;
    const enabled = Boolean(settings.automations[m.key]?.enabled);
    if (!enabled && !opts.ignoreSwitches) {
      out.push({ key: m.key, enabled, candidates: 0, queued: 0, dropped: 0 });
      continue;
    }
    let candidates = await m.evaluate(now, settings);
    if (m.key === 'winback' && candidates.length && !opts.countOnly) {
      // Re-verify dormant addresses first; skip the ones that turn out dead.
      await new VerificationService().reverifyDormant({ olderThanDays: 90, contactIds: candidates.map((c) => c.contactId), now });
      const dead = new Set(
        (await getDb().select({ id: emailContacts.id }).from(emailContacts).where(and(inArray(emailContacts.id, candidates.map((c) => c.contactId)), eq(emailContacts.deliverability, 'invalid')))).map((r) => r.id),
      );
      candidates = candidates.filter((c) => !dead.has(c.contactId));
    }
    const run: AutomationRun = { key: m.key, enabled, candidates: candidates.length, queued: 0, dropped: 0 };
    if (!opts.countOnly) {
      for (const c of candidates) {
        const r = await sends.enqueue({ ...c, now }, undefined, settings);
        if (!r.created) continue;
        if (r.dropped) run.dropped++;
        else run.queued++;
      }
    }
    out.push(run);
  }
  return out;
}

/** An order ends that contact's basket sequences (called by attribution). */
export async function markCartsOrdered(contactId: string, at: Date): Promise<void> {
  await getDb()
    .update(emailCarts)
    .set({ orderedAt: at })
    .where(and(eq(emailCarts.contactId, contactId), isNull(emailCarts.orderedAt), lte(emailCarts.updatedAt, at)));
}
