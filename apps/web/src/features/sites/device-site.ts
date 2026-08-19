/**
 * The site this device is bound to (Aug-2026 feedback set, defects E-1 / B-5).
 *
 * `POST /auth/pin-login` returns the `siteId` the PIN is scoped to, and embeds
 * it in the JWT. The PIN screen used to read only the token and throw the rest
 * away, so `SiteProvider` fell back to "first active site alphabetically" —
 * Birmingham, of the five seeded sites. A venue iPad in South London booked to
 * Birmingham with nothing on screen contradicting it.
 *
 * This is the small store that keeps the device's own answer, so every venue
 * screen can say — loudly — where it is about to write.
 */
const KEY = 'autostock_device_site';

export interface DeviceSite {
  siteId: string | null;
  siteName: string | null;
  label?: string | null;
  roles?: string[];
}

export function getDeviceSite(): DeviceSite | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DeviceSite;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export function setDeviceSite(site: DeviceSite): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(site));
  } catch {
    // Private mode / storage full — the JWT still carries the site, so this is
    // a convenience cache, not the source of truth.
  }
}

export function clearDeviceSite(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to do
  }
}
