/**
 * Backfill (runbook section 1 step 2): one email contact for every address the
 * store already holds, with consent taken only from evidence on record.
 *
 * Addresses come from customers, storefront users, the newsletter list and
 * back-in-stock requests. A contact starts at `all` only where there is
 * evidence of marketing consent — an active newsletter subscription, or a
 * storefront user whose latest general_marketing consent record is a grant —
 * and at `transactional_only` otherwise. The existing suppression list is
 * carried across: unsubscribe and complaint stop marketing, bounce and
 * complaint set deliverability.
 *
 * Idempotent: an existing contact is only linked to its customer / storefront
 * user when it was not already; its consent, deliverability and interests are
 * left alone. Interests and last order are computed only for contacts the run
 * creates, so running it twice changes nothing.
 */
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import {
  consentRecords,
  customerOrders,
  customers,
  emailContacts,
  newsletterSubscribers,
  orderLines,
  productGroups,
  products,
  stockNotifications,
  storefrontUsers,
  suppressionList,
  type InterestMap,
  type MarketingStatus,
} from '../../../db/schema/index.js';
import { isValidEmail, normaliseEmail } from '../lib/normalise.js';
import { addInterestPoints, interestKeysForProduct, DEFAULT_INTEREST_POLICY } from '../lib/interests.js';
import { ContactsService } from './contacts.service.js';

export interface BackfillCounts {
  addresses: number;
  created: number;
  linked: number;
  unchanged: number;
  invalid: number;
  statusAll: number;
  statusTransactionalOnly: number;
  hardBounced: number;
  complained: number;
  trade: number;
  /** How is_trade was decided, for the build log (Part B #11). */
  tradeRule: string;
}

interface Candidate {
  email: string;
  customerId?: string;
  storefrontUserId?: string;
  evidence: Record<string, unknown>;
}

export class BackfillService {
  private db = getDb();
  private contacts = new ContactsService();

  async run(): Promise<BackfillCounts> {
    const counts: BackfillCounts = {
      addresses: 0,
      created: 0,
      linked: 0,
      unchanged: 0,
      invalid: 0,
      statusAll: 0,
      statusTransactionalOnly: 0,
      hardBounced: 0,
      complained: 0,
      trade: 0,
      tradeRule: 'storefront user of kind trade, or any order with 10 or more of one SKU',
    };

    const candidates = new Map<string, Candidate>();
    const add = (raw: string | null, c: Omit<Candidate, 'email'>) => {
      if (!raw) return;
      const email = normaliseEmail(raw);
      if (!isValidEmail(email)) {
        counts.invalid++;
        return;
      }
      const prev = candidates.get(email);
      candidates.set(email, {
        email,
        customerId: prev?.customerId ?? c.customerId,
        storefrontUserId: prev?.storefrontUserId ?? c.storefrontUserId,
        evidence: { ...prev?.evidence, ...c.evidence },
      });
    };

    // Oldest customer first, so the customer a contact links to is stable.
    const customerRows = await this.db
      .select({ id: customers.id, email: customers.email })
      .from(customers)
      .where(and(isNotNull(customers.email), isNull(customers.deletedAt)))
      .orderBy(customers.createdAt, customers.id);
    for (const r of customerRows) add(r.email, { customerId: r.id, evidence: { customer: true } });

    const users = await this.db
      .select({ id: storefrontUsers.id, email: storefrontUsers.email, kind: storefrontUsers.kind })
      .from(storefrontUsers)
      .where(and(isNotNull(storefrontUsers.email), isNull(storefrontUsers.mergedInto)));
    const tradeEmails = new Set<string>();
    for (const u of users) {
      add(u.email, { storefrontUserId: u.id, evidence: { storefrontUser: true } });
      if (u.kind === 'trade' && u.email) tradeEmails.add(normaliseEmail(u.email));
    }

    const news = await this.db
      .select({ email: newsletterSubscribers.email, unsubscribedAt: newsletterSubscribers.unsubscribedAt, subscribedAt: newsletterSubscribers.subscribedAt, source: newsletterSubscribers.source })
      .from(newsletterSubscribers)
      .where(isNull(newsletterSubscribers.deletedAt));
    const newsletter = new Map<string, { active: boolean; at: Date; source: string }>();
    for (const n of news) {
      add(n.email, { evidence: { newsletter: n.source } });
      newsletter.set(normaliseEmail(n.email), { active: !n.unsubscribedAt, at: n.subscribedAt, source: n.source });
    }

    const notifyRows = await this.db
      .selectDistinct({ email: stockNotifications.email })
      .from(stockNotifications)
      .where(isNull(stockNotifications.deletedAt));
    for (const n of notifyRows) add(n.email, { evidence: { backInStockRequest: true } });

    // Latest general_marketing consent per storefront user.
    const consents = await this.db
      .select({
        email: storefrontUsers.email,
        granted: consentRecords.granted,
        source: consentRecords.source,
        at: consentRecords.createdAt,
      })
      .from(consentRecords)
      .innerJoin(storefrontUsers, eq(consentRecords.userId, storefrontUsers.id))
      .where(eq(consentRecords.consentType, 'general_marketing'))
      .orderBy(desc(consentRecords.createdAt));
    const consentByEmail = new Map<string, { granted: boolean; source: string; at: Date }>();
    for (const c of consents) {
      if (!c.email) continue;
      const e = normaliseEmail(c.email);
      if (!consentByEmail.has(e)) consentByEmail.set(e, { granted: c.granted, source: c.source, at: c.at });
    }

    const suppressed = new Map<string, string>();
    for (const s of await this.db.select().from(suppressionList)) suppressed.set(normaliseEmail(s.email), s.reason);

    // Order history per customer: interests, last order, bulk orders.
    const lines = await this.db
      .select({
        customerId: customerOrders.customerId,
        orderDate: customerOrders.orderDate,
        quantity: orderLines.quantity,
        name: products.name,
        groupName: productGroups.name,
        categoryId: products.categoryId,
      })
      .from(orderLines)
      .innerJoin(customerOrders, eq(orderLines.orderId, customerOrders.id))
      .innerJoin(products, eq(orderLines.productId, products.id))
      .leftJoin(productGroups, eq(products.groupId, productGroups.id))
      .where(and(isNull(customerOrders.deletedAt), sql`${customerOrders.status} <> 'CANCELLED'`))
      .orderBy(customerOrders.orderDate);
    const history = new Map<string, { interests: InterestMap; lastOrder: Date; bulk: boolean }>();
    for (const l of lines) {
      const at = new Date(`${l.orderDate}T12:00:00Z`);
      const h = history.get(l.customerId) ?? { interests: {}, lastOrder: at, bulk: false };
      h.interests = addInterestPoints(h.interests, interestKeysForProduct(l), DEFAULT_INTEREST_POLICY.orderPoints, at);
      if (at > h.lastOrder) h.lastOrder = at;
      if (Number(l.quantity) >= 10) h.bulk = true;
      history.set(l.customerId, h);
    }

    for (const cand of candidates.values()) {
      counts.addresses++;
      const nl = newsletter.get(cand.email);
      const consent = consentByEmail.get(cand.email);
      const sup = suppressed.get(cand.email);
      let status: MarketingStatus = 'transactional_only';
      let consentAt: Date | null = null;
      const evidence: Record<string, unknown> = { ...cand.evidence };
      if (consent?.granted) {
        status = 'all';
        consentAt = consent.at;
        evidence.consentRecord = consent.source;
      } else if (nl?.active && !(consent && !consent.granted && consent.at > nl.at)) {
        status = 'all';
        consentAt = nl.at;
        evidence.newsletterSubscribedAt = nl.at.toISOString();
      }
      if (sup === 'unsubscribe' || sup === 'complaint') status = 'transactional_only';

      const hist = cand.customerId ? history.get(cand.customerId) : undefined;
      const isTrade = tradeEmails.has(cand.email) || Boolean(hist?.bulk);

      const before = await this.contacts.getByEmail(cand.email);
      const { contact, created } = await this.contacts.findOrCreateByEmail(cand.email, {
        customerId: cand.customerId,
        storefrontUserId: cand.storefrontUserId,
        source: 'backfill',
        actor: 'system',
        initialStatus: status,
        consentAt,
        evidence,
        isTrade,
        interests: hist?.interests ?? {},
      });

      if (created) {
        counts.created++;
        const patch: Partial<typeof emailContacts.$inferInsert> = {};
        if (hist) patch.lastOrderAt = hist.lastOrder;
        if (sup === 'bounce') patch.deliverability = 'hard_bounce';
        if (sup === 'complaint') patch.deliverability = 'complained';
        if (Object.keys(patch).length) {
          await this.db.update(emailContacts).set(patch).where(eq(emailContacts.id, contact.id));
        }
        if (status === 'all') counts.statusAll++;
        else counts.statusTransactionalOnly++;
        if (sup === 'bounce') counts.hardBounced++;
        if (sup === 'complaint') counts.complained++;
        if (isTrade) counts.trade++;
      } else if (
        before &&
        ((cand.customerId && !before.customerId) || (cand.storefrontUserId && !before.storefrontUserId) || (isTrade && !before.isTrade))
      ) {
        counts.linked++;
      } else {
        counts.unchanged++;
      }

      if (cand.customerId) {
        await this.db
          .update(customers)
          .set({ contactId: contact.id })
          .where(and(eq(customers.id, cand.customerId), isNull(customers.contactId)));
      }
    }

    // Every other customer sharing an address with a linked one.
    await this.db.execute(sql`
      UPDATE customers c SET contact_id = ec.id
      FROM email_contacts ec
      WHERE c.contact_id IS NULL AND c.email IS NOT NULL AND lower(btrim(c.email)) = ec.email
    `);

    return counts;
  }
}
