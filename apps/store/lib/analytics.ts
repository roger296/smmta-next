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
