'use client';

/**
 * Reports a completed order to Google Analytics, exactly once.
 *
 * Renders nothing. Two things it has to get right:
 *
 *   - **Timing.** The cookie banner that starts the tag lives in the layout,
 *     and React runs a page's effects before its layout's, so the tag may not
 *     be running yet on the first attempt. It waits a few seconds for it.
 *   - **Counting once.** A customer who refreshes this page, or comes back to
 *     it from the confirmation email, must not be counted as a second sale, so
 *     the order is marked as reported in this browser the moment it is sent.
 */
import { useEffect } from 'react';
import {
  claimPurchase,
  gaEvent,
  hasAnalytics,
  purchaseEventParams,
  type OrderForAnalytics,
} from '@/lib/analytics';

const RETRY_MS = 300;
const GIVE_UP_MS = 10_000;

export function PurchaseEvent({ orderId, order }: { orderId: string; order: OrderForAnalytics }) {
  useEffect(() => {
    let done = false;
    /** True when there is nothing left to do: sent, already counted, or stopped. */
    const attempt = (): boolean => {
      if (done) return true;
      // No consent (or not started yet) — nothing to send to.
      if (!hasAnalytics()) return false;
      // Claim only once we can actually send, so a dropped attempt doesn't
      // mark the order as counted.
      if (claimPurchase(orderId)) gaEvent('purchase', purchaseEventParams(order));
      return true;
    };

    if (attempt()) return;
    const timer = setInterval(() => {
      if (attempt()) clearInterval(timer);
    }, RETRY_MS);
    const giveUp = setTimeout(() => clearInterval(timer), GIVE_UP_MS);
    return () => {
      done = true;
      clearInterval(timer);
      clearTimeout(giveUp);
    };
    // The order is settled by the time this page renders; only its id matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  return null;
}
