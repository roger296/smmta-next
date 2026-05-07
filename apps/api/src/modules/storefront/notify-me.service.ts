/**
 * NotifyMeService — persistence + dispatch for "notify me when back in stock".
 *
 * Three responsibilities:
 *   1. Record a customer's interest in a specific product (idempotent).
 *   2. (Optionally) add them to the newsletter list as a side-effect.
 *   3. After a GRN books in stock, decide which pending notifications to
 *      fulfil and dispatch them via the storefront's internal email route.
 *
 * The "free stock" semantic must agree with what the storefront already
 * shows on the PDP, so the trigger reuses `IN_STOCK` count from
 * `stock_items` (RESERVED and ALLOCATED rows are already excluded — this
 * is the same calculation `CatalogueService.availableQtyMap` uses). The
 * helper lives here as a public method so other modules don't have to
 * reach into the catalogue service.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { getDb } from '../../config/database.js';
import {
  newsletterSubscribers,
  products,
  stockItems,
  stockNotifications,
} from '../../db/schema/index.js';

export interface NotifyMeInput {
  productId: string;
  email: string;
  subscribeToNewsletter: boolean;
}

export interface NotifyMeResult {
  ok: true;
  /** True when this submission created a brand-new pending row;
   *  false when it just updated the newsletter flag on an existing one. */
  created: boolean;
}

/** Payload pushed at the storefront's internal send route. */
export interface NotifyMeSendPayload {
  email: string;
  productId: string;
  productName: string;
  productSlug: string | null;
  productImageUrl: string | null;
  priceGbp: string | null;
  colour: string | null;
}

export interface NotifyMeSender {
  send(payload: NotifyMeSendPayload): Promise<void>;
}

export class NotifyMeService {
  private db = getDb();

  /** Normalise emails before persisting / comparing. */
  private normaliseEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /**
   * Persist the customer's request. Idempotent on `(productId, email)`
   * for currently-pending rows (the partial unique index in the schema
   * enforces this). If the customer re-submits the same email and
   * toggles the newsletter checkbox, the existing row is updated.
   */
  async record(companyId: string, input: NotifyMeInput): Promise<NotifyMeResult> {
    const email = this.normaliseEmail(input.email);
    const existing = await this.db.query.stockNotifications.findFirst({
      where: and(
        eq(stockNotifications.productId, input.productId),
        eq(stockNotifications.email, email),
        isNull(stockNotifications.fulfilledAt),
        isNull(stockNotifications.deletedAt),
      ),
    });

    let created = false;
    if (existing) {
      // Allow toggling the newsletter flag on a re-submit. Don't move
      // requestedAt — fairness is FIFO from the original request.
      if (existing.subscribedToNewsletter !== input.subscribeToNewsletter) {
        await this.db
          .update(stockNotifications)
          .set({
            subscribedToNewsletter: input.subscribeToNewsletter,
            updatedAt: new Date(),
          })
          .where(eq(stockNotifications.id, existing.id));
      }
    } else {
      await this.db.insert(stockNotifications).values({
        companyId,
        productId: input.productId,
        email,
        subscribedToNewsletter: input.subscribeToNewsletter,
      });
      created = true;
    }

    if (input.subscribeToNewsletter) {
      await this.upsertNewsletterSubscriber(companyId, email);
    }

    return { ok: true, created };
  }

  /**
   * Insert a newsletter subscriber if absent. If the row already exists
   * and they're currently unsubscribed, this PR deliberately does not
   * resurrect them — re-subscription should go through a separate
   * (eventual) double-opt-in flow.
   */
  private async upsertNewsletterSubscriber(
    companyId: string,
    email: string,
  ): Promise<void> {
    const token = randomBytes(32).toString('hex');
    await this.db
      .insert(newsletterSubscribers)
      .values({
        companyId,
        email,
        source: 'stock_notification',
        unsubscribeToken: token,
      })
      .onConflictDoNothing({ target: newsletterSubscribers.email });
  }

  /**
   * Free stock for a product = IN_STOCK count, excluding RESERVED and
   * ALLOCATED. Matches `CatalogueService.availableQtyMap`'s definition
   * exactly so the trigger can't disagree with what the PDP shows.
   */
  async getFreeStock(companyId: string, productId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(stockItems)
      .where(
        and(
          eq(stockItems.companyId, companyId),
          eq(stockItems.productId, productId),
          eq(stockItems.status, 'IN_STOCK'),
          isNull(stockItems.deletedAt),
        ),
      );
    return Number(row?.n ?? 0);
  }

  /**
   * Find pending notifications for a product, oldest first. Returns at
   * most `cap` rows so the caller can avoid emailing more customers
   * than there are units of free stock.
   */
  async listPending(productId: string, cap: number): Promise<
    Array<typeof stockNotifications.$inferSelect>
  > {
    if (cap <= 0) return [];
    return this.db.query.stockNotifications.findMany({
      where: and(
        eq(stockNotifications.productId, productId),
        isNull(stockNotifications.fulfilledAt),
        isNull(stockNotifications.deletedAt),
      ),
      orderBy: [asc(stockNotifications.requestedAt)],
      limit: cap,
    });
  }

  /**
   * After a stock booking-in (or any operation that creates IN_STOCK
   * units), dispatch back-in-stock emails to as many pending customers
   * as there are free units, oldest-first. Sends are made via the
   * caller-supplied `sender`; persistence (marking `fulfilledAt`) is
   * done here only after the sender resolves successfully — so a
   * sender failure leaves the row pending for the next trigger.
   *
   * Returns the count of notifications sent. Does nothing if free stock
   * is zero or there are no pending requests.
   */
  async fulfilForProduct(
    companyId: string,
    productId: string,
    sender: NotifyMeSender,
  ): Promise<number> {
    const freeStock = await this.getFreeStock(companyId, productId);
    if (freeStock <= 0) return 0;

    const pending = await this.listPending(productId, freeStock);
    if (pending.length === 0) return 0;

    const product = await this.db.query.products.findFirst({
      where: eq(products.id, productId),
    });
    if (!product) return 0;

    let sent = 0;
    for (const row of pending) {
      try {
        await sender.send({
          email: row.email,
          productId: product.id,
          productName: product.name,
          productSlug: product.slug,
          productImageUrl: product.heroImageUrl,
          priceGbp: product.minSellingPrice ?? null,
          colour: product.colour,
        });
        await this.db
          .update(stockNotifications)
          .set({ fulfilledAt: new Date(), updatedAt: new Date() })
          .where(eq(stockNotifications.id, row.id));
        sent++;
      } catch {
        // Leave the row pending; a future trigger can retry. Don't
        // log the address verbatim — PII.
      }
    }
    return sent;
  }
}
