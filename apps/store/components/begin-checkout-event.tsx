'use client';

/**
 * Reports that a basket reached the checkout, once per attempt.
 *
 * Renders nothing. Same timing problem as the purchase event: the cookie
 * banner that starts the tag lives in the layout, and React runs a page's
 * effects before its layout's, so the tag may not be running on the first
 * attempt and this waits a few seconds for it.
 *
 * A reload of the checkout shouldn't add a second step to the funnel, but
 * going back, changing the basket and returning should — hence a token
 * built from the basket's contents rather than its id alone.
 */
import { useEffect } from 'react';
import {
  beginCheckoutEventParams,
  beginCheckoutToken,
  claimBeginCheckout,
  gaEvent,
  hasAnalytics,
  type CartForAnalytics,
} from '@/lib/analytics';

const RETRY_MS = 300;
const GIVE_UP_MS = 10_000;

export function BeginCheckoutEvent({ cart }: { cart: CartForAnalytics }) {
  const token = beginCheckoutToken(cart);

  useEffect(() => {
    let done = false;
    /** True when there is nothing left to do: sent, already counted, or stopped. */
    const attempt = (): boolean => {
      if (done) return true;
      // No consent (or not started yet) — nothing to send to.
      if (!hasAnalytics()) return false;
      // Claim only once we can actually send, so a dropped attempt doesn't
      // mark the attempt as counted.
      if (claimBeginCheckout(token)) gaEvent('begin_checkout', beginCheckoutEventParams(cart));
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
    // The basket is fixed for this render; the token captures what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return null;
}
