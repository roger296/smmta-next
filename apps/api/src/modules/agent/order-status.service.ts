/**
 * Order lookup for the order-status specialist.
 *
 * Two ways in:
 *   - Signed in: the chat session carries a storefront user, so we
 *     resolve their email and read their own orders. No further proof.
 *   - Anonymous: order number AND the email used on the order, both
 *     matching exactly. This is the bar most retailers use, and it's
 *     the one chosen for this build.
 *
 * Three rules shape everything here:
 *
 *   1. NEVER confirm an order exists on the reference alone. A wrong
 *      email and an unknown order number return the identical "not
 *      found" result, so the tool can't be used to test whether a given
 *      order number is real.
 *
 *   2. Only customer-safe fields leave this module. Internal
 *      operational statuses (PARTIALLY_ALLOCATED, INVOICED) are mapped
 *      to something a customer can act on, and margin/cogs/revenue are
 *      never selected in the first place — not selected rather than
 *      selected-and-stripped, so a later refactor can't leak them.
 *
 *   3. Failed lookups are capped per chat session. Order numbers may be
 *      guessable; requiring the email too is the real control, but a
 *      cap makes enumeration within a session pointless as well.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../config/database.js';
import { getSingletonCompanyId } from '../../shared/auth/company.js';
import {
  customerOrders,
  customers,
  storefrontUsers,
} from '../../db/schema/index.js';

/** Customer-facing order state. The internal enum has twelve values
 *  covering warehouse operations; a customer needs to know which of
 *  these five situations they're in. */
export type CustomerFacingStatus =
  | 'placed'
  | 'preparing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'on_hold';

export interface OrderStatusView {
  orderNumber: string;
  status: CustomerFacingStatus;
  /** Plain-English line the specialist can use directly. */
  statusText: string;
  orderDate: string;
  shippedDate: string | null;
  trackingNumber: string | null;
  trackingLink: string | null;
  courierName: string | null;
  grandTotal: string | null;
}

export type LookupResult =
  | { found: true; orders: OrderStatusView[] }
  | { found: false; reason: 'not_found' | 'no_orders' | 'rate_limited' };

/**
 * Map the internal operational status onto something a customer can
 * act on.
 *
 * INVOICED and COMPLETED both mean the goods have gone — from the
 * warehouse's point of view they're different stages of paperwork, but
 * telling a customer their order is "invoiced" answers a question they
 * didn't ask. Anything still being picked reads as "preparing".
 */
export function toCustomerStatus(internal: string, shippedDate: unknown): CustomerFacingStatus {
  switch (internal) {
    case 'CANCELLED':
      return 'cancelled';
    case 'ON_HOLD':
      return 'on_hold';
    case 'SHIPPED':
    case 'PARTIALLY_SHIPPED':
      return 'shipped';
    case 'INVOICED':
    case 'COMPLETED':
      // Completed without a dispatch date is a paperwork close on
      // something that never shipped — don't claim it was delivered.
      return shippedDate ? 'delivered' : 'preparing';
    case 'DRAFT':
    case 'CONFIRMED':
      return 'placed';
    default:
      // ALLOCATED, PARTIALLY_ALLOCATED, BACK_ORDERED, READY_TO_SHIP
      return 'preparing';
  }
}

/** One-line description the specialist can use verbatim. Kept here
 *  rather than in the prompt so the wording can't drift per model. */
export function statusText(status: CustomerFacingStatus, hasTracking: boolean): string {
  switch (status) {
    case 'placed':
      return 'Order received and waiting to be picked.';
    case 'preparing':
      return 'Being picked and packed in the warehouse.';
    case 'shipped':
      return hasTracking
        ? 'Dispatched — tracking is available.'
        : 'Dispatched from the warehouse.';
    case 'delivered':
      return 'Marked as delivered.';
    case 'cancelled':
      return 'Cancelled.';
    case 'on_hold':
      return 'On hold — the team needs to look at this one.';
  }
}

/**
 * Per-session failed-lookup budget.
 *
 * In-process, because the API is one process per deploy and this is a
 * speed bump rather than a security boundary — the email requirement is
 * the actual control. An attacker can still open a new chat session,
 * but they'd need a valid email address for the order either way.
 */
const MAX_FAILED_LOOKUPS_PER_SESSION = 5;
const failedLookups = new Map<string, number>();

/** Exposed for tests. */
export function _resetLookupBudget(): void {
  failedLookups.clear();
}

/** How many orders we'll return for a signed-in customer asking
 *  generally. Enough to cover "my last couple of orders" without
 *  turning the reply into a statement. */
const RECENT_ORDER_LIMIT = 3;

export class OrderStatusService {
  private db = getDb();
  private companyId = getSingletonCompanyId();

  private overBudget(sessionId: string): boolean {
    return (failedLookups.get(sessionId) ?? 0) >= MAX_FAILED_LOOKUPS_PER_SESSION;
  }

  private recordFailure(sessionId: string): void {
    failedLookups.set(sessionId, (failedLookups.get(sessionId) ?? 0) + 1);
  }

  /** Recent orders for the signed-in customer on this chat session. */
  async lookupByAccount(userId: string): Promise<LookupResult> {
    const [user] = await this.db
      .select({ email: storefrontUsers.email })
      .from(storefrontUsers)
      .where(eq(storefrontUsers.id, userId))
      .limit(1);
    if (!user?.email) return { found: false, reason: 'no_orders' };

    const rows = await this.selectOrders(
      and(
        eq(customerOrders.companyId, this.companyId),
        isNull(customerOrders.deletedAt),
        sql`lower(${customers.email}) = lower(${user.email})`,
      ),
      RECENT_ORDER_LIMIT,
    );
    if (rows.length === 0) return { found: false, reason: 'no_orders' };
    return { found: true, orders: rows };
  }

  /**
   * Anonymous lookup. Both fields must match.
   *
   * A wrong email and an unknown order number are indistinguishable in
   * the result — that's the point, not an oversight.
   */
  async lookupByRefAndEmail(
    sessionId: string,
    orderRef: string,
    email: string,
  ): Promise<LookupResult> {
    if (this.overBudget(sessionId)) return { found: false, reason: 'rate_limited' };

    const ref = orderRef.trim();
    const mail = email.trim();
    if (!ref || !mail) {
      this.recordFailure(sessionId);
      return { found: false, reason: 'not_found' };
    }

    const rows = await this.selectOrders(
      and(
        eq(customerOrders.companyId, this.companyId),
        isNull(customerOrders.deletedAt),
        // Case- and whitespace-insensitive on both: customers paste
        // order numbers with stray spaces and type emails in any case.
        sql`upper(trim(${customerOrders.orderNumber})) = upper(${ref})`,
        sql`lower(${customers.email}) = lower(${mail})`,
      ),
      1,
    );

    if (rows.length === 0) {
      this.recordFailure(sessionId);
      return { found: false, reason: 'not_found' };
    }
    return { found: true, orders: rows };
  }

  /**
   * The single place order fields are read. Selects ONLY
   * customer-safe columns — margin, cogs, revenue, and internal ids are
   * never fetched, so they can't leak through a later change here.
   */
  private async selectOrders(
    where: ReturnType<typeof and>,
    limit: number,
  ): Promise<OrderStatusView[]> {
    const rows = await this.db
      .select({
        orderNumber: customerOrders.orderNumber,
        status: customerOrders.status,
        orderDate: customerOrders.orderDate,
        shippedDate: customerOrders.shippedDate,
        trackingNumber: customerOrders.trackingNumber,
        trackingLink: customerOrders.trackingLink,
        courierName: customerOrders.courierName,
        grandTotal: customerOrders.grandTotal,
      })
      .from(customerOrders)
      .innerJoin(customers, eq(customers.id, customerOrders.customerId))
      .where(where)
      .orderBy(desc(customerOrders.orderDate))
      .limit(limit);

    return rows.map((r) => {
      const status = toCustomerStatus(r.status, r.shippedDate);
      return {
        orderNumber: r.orderNumber,
        status,
        statusText: statusText(status, Boolean(r.trackingNumber || r.trackingLink)),
        orderDate: String(r.orderDate),
        shippedDate: r.shippedDate ? String(r.shippedDate) : null,
        trackingNumber: r.trackingNumber ?? null,
        trackingLink: r.trackingLink ?? null,
        courierName: r.courierName ?? null,
        grandTotal: r.grandTotal ?? null,
      };
    });
  }
}
