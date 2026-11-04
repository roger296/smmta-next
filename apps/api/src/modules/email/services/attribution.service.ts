/**
 * What the email system learns from an order (runbook section 6 item 7).
 * Run by the worker on `order.created` and `order.paid`, once per order:
 *
 *  - Attribution: the order is credited to the most recent email the contact
 *    clicked in the 5 days before it (setting attribution_window_days).
 *  - The contact's last order date, and +10 interest for what was bought.
 *  - A customer with an address but no contact gets one (no marketing
 *    consent from an order alone).
 */
import { and, desc, eq, gte, isNotNull, isNull, lte } from 'drizzle-orm';
import { getDb } from '../../../config/database.js';
import {
  customerOrders,
  customers,
  emailContacts,
  emailSends,
  orderLines,
  productGroups,
  products,
} from '../../../db/schema/index.js';
import { interestKeysForProduct } from '../lib/interests.js';
import { isValidEmail, normaliseEmail } from '../lib/normalise.js';
import { ContactsService } from './contacts.service.js';
import { getEmailSettings } from './settings.service.js';
import { markCartsOrdered } from './automations.service.js';

const DAY_MS = 86_400_000;

export type OrderOutcome =
  | { status: 'already_processed' | 'not_found' | 'no_contact' }
  | { status: 'processed'; attributedSendId: string | null };

export class AttributionService {
  private contacts = new ContactsService();

  async processOrder(orderId: string): Promise<OrderOutcome> {
    const db = getDb();
    const [order] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderId)).limit(1);
    if (!order) return { status: 'not_found' };
    if (order.emailProcessedAt) return { status: 'already_processed' };

    const [customer] = await db.select().from(customers).where(eq(customers.id, order.customerId)).limit(1);
    let contactId = customer?.contactId ?? null;
    if (!contactId && customer?.email && isValidEmail(normaliseEmail(customer.email))) {
      const { contact } = await this.contacts.findOrCreateByEmail(customer.email, { source: 'order', customerId: customer.id });
      contactId = contact.id;
      await db.update(customers).set({ contactId }).where(and(eq(customers.id, customer.id), isNull(customers.contactId)));
    }
    const orderedAt = order.createdAt;
    if (!contactId) {
      await db.update(customerOrders).set({ emailProcessedAt: new Date() }).where(eq(customerOrders.id, orderId));
      return { status: 'no_contact' };
    }

    const settings = await getEmailSettings();
    const [click] = await db
      .select({ id: emailSends.id, campaignId: emailSends.campaignId })
      .from(emailSends)
      .where(
        and(
          eq(emailSends.contactId, contactId),
          isNotNull(emailSends.firstClickAt),
          gte(emailSends.firstClickAt, new Date(orderedAt.getTime() - settings.attribution_window_days * DAY_MS)),
          lte(emailSends.firstClickAt, orderedAt),
        ),
      )
      .orderBy(desc(emailSends.firstClickAt))
      .limit(1);

    const lines = await db
      .select({ name: products.name, groupName: productGroups.name, categoryId: products.categoryId })
      .from(orderLines)
      .innerJoin(products, eq(orderLines.productId, products.id))
      .leftJoin(productGroups, eq(products.groupId, productGroups.id))
      .where(eq(orderLines.orderId, orderId));
    const keys = [...new Set(lines.flatMap((l) => interestKeysForProduct(l)))];

    await db.transaction(async (tx) => {
      // Claim the order first, so a concurrent run does nothing.
      const claimed = await tx
        .update(customerOrders)
        .set({ emailProcessedAt: new Date(), emailSendId: click?.id ?? null, emailCampaignId: click?.campaignId ?? null })
        .where(and(eq(customerOrders.id, orderId), isNull(customerOrders.emailProcessedAt)))
        .returning({ id: customerOrders.id });
      if (claimed.length === 0) return;
      const [c] = await tx.select({ lastOrderAt: emailContacts.lastOrderAt }).from(emailContacts).where(eq(emailContacts.id, contactId!));
      if (!c?.lastOrderAt || c.lastOrderAt < orderedAt) {
        await tx.update(emailContacts).set({ lastOrderAt: orderedAt }).where(eq(emailContacts.id, contactId!));
      }
      await this.contacts.addInterest(contactId!, keys, settings.interest_decay.order_points, orderedAt, undefined, tx);
    });
    // An order ends the contact's abandoned-basket sequences.
    await markCartsOrdered(contactId, orderedAt);
    return { status: 'processed', attributedSendId: click?.id ?? null };
  }
}
