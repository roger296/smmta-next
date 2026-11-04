/**
 * Every link in an email that points at the shop carries the campaign's
 * tracking (spec § Campaign types): utm_source=email, utm_medium=<class>,
 * utm_campaign=<campaign or kind>, eid=<send id>. Product links also carry
 * the interest keys they stand for (`ik`), which the click webhook credits.
 * Links elsewhere are left alone.
 */
import { storefrontBaseUrl } from '../lib/config.js';
import { signedLink } from '../lib/tokens.js';
import type { EmailClass } from '../../../db/schema/index.js';

export interface LinkContext {
  cls: EmailClass;
  kind: string;
  sendId: string;
  campaignId: string | null;
  utmCampaign?: string | null;
  contactId: string;
}

export function storeUrl(path = '/'): string {
  return `${storefrontBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}

export function trackLink(url: string, ctx: LinkContext, interestKeys: string[] = []): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const store = new URL(storefrontBaseUrl());
  if (u.host !== store.host) return url;
  // The unsubscribe and preferences pages are not campaign traffic.
  if (u.pathname.startsWith('/email/')) return url;
  u.searchParams.set('utm_source', 'email');
  u.searchParams.set('utm_medium', ctx.cls);
  u.searchParams.set('utm_campaign', ctx.utmCampaign || ctx.campaignId || ctx.kind);
  u.searchParams.set('eid', ctx.sendId);
  const keys = interestKeys.filter((k) => /^(material|category):[A-Za-z0-9-]+$/.test(k));
  if (keys.length) u.searchParams.set('ik', keys.join(','));
  return u.toString();
}

/** The product page: the range page with the colour picked, or the
 *  product's own page when it has no range. */
export function productUrl(p: { groupSlug?: string | null; slug?: string | null; colour?: string | null }): string {
  if (p.groupSlug) {
    const url = storeUrl(`/shop/${encodeURIComponent(p.groupSlug)}`);
    return p.colour ? `${url}?colour=${encodeURIComponent(p.colour.toLowerCase())}` : url;
  }
  if (p.slug) {
    const url = storeUrl(`/shop/${encodeURIComponent(p.slug)}`);
    return p.colour ? `${url}?colour=${encodeURIComponent(p.colour.toLowerCase())}` : url;
  }
  return storeUrl('/shop');
}

/** Signed one-click add-to-cart link for an exact variant (30 days). The
 *  storefront's /cart/add route has the API check the token, adds the line
 *  and shows the cart; it grants no account access. */
export function cartLink(productId: string, quantity: number, contactId: string, now = Date.now()): string {
  const t = signedLink({ p: productId, q: quantity, c: contactId }, 30 * 86_400, now);
  return storeUrl(`/cart/add?t=${encodeURIComponent(t)}`);
}
