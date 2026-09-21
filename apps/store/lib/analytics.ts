/**
 * Google Analytics 4 for this storefront, behind cookie consent.
 *
 * Analytics cookies are not strictly necessary, so under UK PECR and GDPR
 * nothing from Google loads until the visitor accepts. The choice itself is
 * kept in localStorage: remembering it is strictly necessary and needs no
 * consent of its own.
 *
 * Tenant configuration, like lib/legal.ts: a re-skinned storefront sets its own
 * Measurement ID here. Client-safe — no server-only imports and nothing secret,
 * since a Measurement ID is published in every page that loads the tag.
 */

/** GA4 web stream for filament.cleverdeals.net (property 484721657). */
import { tieredUnitPricePence } from '@smmta/shared-types';

export const GA_MEASUREMENT_ID = 'G-3RJWFM59VV';

export const CONSENT_STORAGE_KEY = 'store_cookie_consent';
/** Bump when what visitors are asked to agree to changes, so everyone is asked again. */
export const CONSENT_VERSION = 1;
/** Dispatched on window by the footer's "Cookie settings" link to reopen the banner. */
export const OPEN_COOKIE_SETTINGS_EVENT = 'store:open-cookie-settings';

export type AnalyticsConsent = 'granted' | 'denied';

export function isMeasurementId(id: string): boolean {
  return /^G-[A-Z0-9]{4,20}$/.test(id);
}

/**
 * The Measurement ID to use, or null for no analytics — and so no banner,
 * because without analytics the site sets no cookies that need consent.
 * STORE_ANALYTICS_DISABLED=true switches it off: CI sets it so a banner can
 * never sit over an element the checkout tests click.
 */
export function resolveMeasurementId(
  env: { STORE_ANALYTICS_DISABLED?: string },
  id: string = GA_MEASUREMENT_ID,
): string | null {
  if (env.STORE_ANALYTICS_DISABLED === 'true') return null;
  return isMeasurementId(id) ? id : null;
}

export function serialiseConsent(choice: AnalyticsConsent, now: Date = new Date()): string {
  return JSON.stringify({ v: CONSENT_VERSION, analytics: choice, at: now.toISOString() });
}

/** The stored choice, or null if there is none, it is unreadable, or it predates CONSENT_VERSION. */
export function parseConsent(raw: string | null | undefined): AnalyticsConsent | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; analytics?: unknown };
    if (parsed.v !== CONSENT_VERSION) return null;
    return parsed.analytics === 'granted' || parsed.analytics === 'denied' ? parsed.analytics : null;
  } catch {
    return null;
  }
}

/** Names of the Google Analytics cookies in a `document.cookie` string. */
export function analyticsCookieNames(cookieString: string): string[] {
  return cookieString
    .split(';')
    .map((c) => c.split('=')[0]!.trim())
    .filter((name) => /^_ga($|_)/.test(name) || name === '_gid' || name.startsWith('_gat'));
}

/**
 * Every domain a GA cookie may have been set on for this hostname: the host and
 * each parent domain. GA's automatic cookie domain picks the highest one it can
 * (.cleverdeals.net), and a cookie can only be deleted with the domain it was
 * set with.
 */
export function cookieDomainsFor(hostname: string): string[] {
  if (!hostname.includes('.') || /^\d+(\.\d+){3}$/.test(hostname)) return [hostname];
  const parts = hostname.split('.');
  const domains = [hostname];
  for (let i = 0; i < parts.length - 1; i++) domains.push(`.${parts.slice(i).join('.')}`);
  return domains;
}


// ---------------------------------------------------------------------------
// Ecommerce events
//
// Nothing here loads or configures Google Analytics: `gaEvent` is a no-op
// unless the tag is already running, which only happens after the visitor has
// accepted cookies. So a refusal means no events, without every call site
// having to check.
// ---------------------------------------------------------------------------

/** One line of an ecommerce event, in GA4's shape. */
export interface GaItem {
  item_id: string;
  item_name: string;
  price?: number;
  quantity?: number;
  /** Colour, or colour and size — what distinguishes this variant. */
  item_variant?: string;
  item_brand?: string;
}

type GtagWindow = Window & { gtag?: (...args: unknown[]) => void };

/** Send an event to GA4, or do nothing when analytics isn't running. */
export function gaEvent(name: string, params: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  const gtag = (window as GtagWindow).gtag;
  if (typeof gtag !== 'function') return;
  gtag('event', name, params);
}

/** True once the tag is running, i.e. the visitor accepted cookies. */
export function hasAnalytics(): boolean {
  return typeof window !== 'undefined' && typeof (window as GtagWindow).gtag === 'function';
}

/** Money as GA4 wants it: a number, or undefined when we don't have one. */
export function gaPrice(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

/** The variant label for an item: "Bottle Green · XL", or just the colour. */
export function gaVariant(parts: Array<string | null | undefined>): string | undefined {
  const kept = parts.filter((p): p is string => Boolean(p && p.trim()));
  return kept.length > 0 ? kept.join(' · ') : undefined;
}

/** What a call site knows about the item being added to the basket. */
export interface CartItemForAnalytics {
  id: string;
  name: string;
  /** The FLOOR price — what a unit costs at the volume quantity. */
  priceGbp?: string | number | null;
  /** The ceiling: what a single unit costs. Absent for a product that
   *  doesn't slide, where the floor is the only price it has. */
  maxPriceGbp?: string | number | null;
  colour?: string | null;
  size?: string | null;
  brand?: string | null;
}

const toPence = (value: number) => Math.round(value * 100);

/**
 * What a customer actually pays per unit for the quantity being added.
 *
 * Filament slides with volume: `priceGbp` is the 10+ rate and `maxPriceGbp`
 * is a single unit, roughly twice as much. Reporting the floor for a
 * one-roll basket told Analytics £6.50 for a £13.00 sale, and disagreed
 * with the begin_checkout and purchase events, which read the real basket.
 */
export function unitPriceForQuantity(
  item: CartItemForAnalytics,
  quantity: number,
): number | undefined {
  const floor = gaPrice(item.priceGbp);
  if (floor === undefined) return undefined;
  const ceiling = gaPrice(item.maxPriceGbp);
  return tieredUnitPricePence(toPence(floor), ceiling === undefined ? null : toPence(ceiling), quantity) / 100;
}

/** The `add_to_cart` event for one item. Pure, so it can be tested. */
export function addToCartEventParams(
  item: CartItemForAnalytics,
  quantity: number,
): Record<string, unknown> {
  const price = unitPriceForQuantity(item, quantity);
  return {
    currency: 'GBP',
    value: price === undefined ? undefined : Number((price * quantity).toFixed(2)),
    items: [
      {
        item_id: item.id,
        item_name: item.name,
        price,
        quantity,
        item_variant: gaVariant([item.colour, item.size]),
        item_brand: item.brand ?? undefined,
      },
    ],
  };
}

export interface OrderForAnalytics {
  orderNumber: string;
  currencyCode?: string | null;
  totals: { grandTotal: string; taxTotal?: string; deliveryCharge?: string };
  lines: Array<{
    productSlug: string | null;
    productName: string | null;
    colour?: string | null;
    size?: string | null;
    quantity: number;
    pricePerUnit: string;
  }>;
}

/** The `purchase` event for an order. Pure, so it can be tested without a browser. */
export function purchaseEventParams(order: OrderForAnalytics): Record<string, unknown> {
  return {
    transaction_id: order.orderNumber,
    // The whole amount the customer paid, delivery and VAT included.
    value: gaPrice(order.totals.grandTotal) ?? 0,
    tax: gaPrice(order.totals.taxTotal),
    shipping: gaPrice(order.totals.deliveryCharge),
    currency: order.currencyCode || 'GBP',
    items: order.lines.map((line) => ({
      item_id: line.productSlug ?? '',
      item_name: line.productName ?? '',
      price: gaPrice(line.pricePerUnit),
      quantity: line.quantity,
      item_variant: gaVariant([line.colour, line.size]),
    })),
  };
}

/** Where a sent purchase is remembered, so a refresh doesn't count it twice. */
export function purchaseSentKey(orderId: string): string {
  return `store_ga_purchase_${orderId}`;
}

/**
 * True the first time an order is seen, false afterwards. A customer who
 * refreshes the confirmation page, or returns to it from their email, must not
 * be counted as a second sale. Storage being unavailable is not a reason to
 * lose the sale, so it reports the event once and accepts the risk.
 */
export function claimPurchase(orderId: string): boolean {
  if (typeof window === 'undefined') return false;
  const key = purchaseSentKey(orderId);
  try {
    if (window.localStorage.getItem(key)) return false;
    window.localStorage.setItem(key, new Date().toISOString());
    return true;
  } catch {
    return true;
  }
}

/** A basket as the checkout page knows it. */
export interface CartForAnalytics {
  cartId: string | null;
  currencyCode?: string | null;
  subtotalGbp: string;
  lines: Array<{
    productId: string;
    slug?: string | null;
    name?: string | null;
    colour?: string | null;
    size?: string | null;
    quantity: number;
    pricePerUnitGbp: string;
  }>;
}

/** The `begin_checkout` event for a basket. Pure, so it can be tested. */
export function beginCheckoutEventParams(cart: CartForAnalytics): Record<string, unknown> {
  return {
    currency: cart.currencyCode || 'GBP',
    // The basket total. Delivery isn't settled yet at this point, so unlike
    // `purchase` this is the subtotal, which is what GA4 expects here.
    value: gaPrice(cart.subtotalGbp) ?? 0,
    items: cart.lines.map((line) => ({
      item_id: line.slug ?? line.productId,
      item_name: line.name ?? '',
      price: gaPrice(line.pricePerUnitGbp),
      quantity: line.quantity,
      item_variant: gaVariant([line.colour, line.size]),
    })),
  };
}

/**
 * What makes one visit to the checkout distinct from another. Reloading the
 * page shouldn't add a second funnel step, but going back, changing the
 * basket and returning is a genuine new attempt — so the basket's contents
 * are part of the token, not just its id.
 */
export function beginCheckoutToken(cart: CartForAnalytics): string {
  const lines = cart.lines.map((l) => `${l.productId}x${l.quantity}`).join(',');
  return `${cart.cartId ?? 'anon'}|${cart.subtotalGbp}|${lines}`;
}

/**
 * True the first time this basket reaches the checkout in this browsing
 * session. Session storage, not local: someone who comes back tomorrow and
 * checks out the same basket is starting a new attempt, and should count.
 */
export function claimBeginCheckout(token: string): boolean {
  if (typeof window === 'undefined') return false;
  const key = `store_ga_begin_checkout_${token}`;
  try {
    if (window.sessionStorage.getItem(key)) return false;
    window.sessionStorage.setItem(key, new Date().toISOString());
    return true;
  } catch {
    return true;
  }
}
