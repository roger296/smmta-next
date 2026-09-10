import { describe, expect, it } from 'vitest';
import {
  CONSENT_VERSION,
  GA_MEASUREMENT_ID,
  analyticsCookieNames,
  cookieDomainsFor,
  isMeasurementId,
  parseConsent,
  resolveMeasurementId,
  serialiseConsent,
} from './analytics';

describe('measurement ID', () => {
  it('is configured with a valid GA4 Measurement ID', () => {
    expect(isMeasurementId(GA_MEASUREMENT_ID)).toBe(true);
  });

  it('rejects a property ID, which is what GA shows first and is easy to paste by mistake', () => {
    expect(isMeasurementId('484721657')).toBe(false);
    expect(resolveMeasurementId({}, '484721657')).toBeNull();
  });

  it('is switched off by STORE_ANALYTICS_DISABLED=true, and only by exactly that', () => {
    expect(resolveMeasurementId({ STORE_ANALYTICS_DISABLED: 'true' })).toBeNull();
    expect(resolveMeasurementId({ STORE_ANALYTICS_DISABLED: 'false' })).toBe(GA_MEASUREMENT_ID);
    expect(resolveMeasurementId({})).toBe(GA_MEASUREMENT_ID);
  });
});

describe('stored consent', () => {
  it('round-trips both choices', () => {
    expect(parseConsent(serialiseConsent('granted'))).toBe('granted');
    expect(parseConsent(serialiseConsent('denied'))).toBe('denied');
  });

  it('treats no choice, a garbled value, or an old version as not yet asked', () => {
    expect(parseConsent(null)).toBeNull();
    expect(parseConsent('yes')).toBeNull();
    expect(parseConsent(JSON.stringify({ v: CONSENT_VERSION + 1, analytics: 'granted' }))).toBeNull();
    expect(parseConsent(JSON.stringify({ v: CONSENT_VERSION, analytics: 'maybe' }))).toBeNull();
  });
});

describe('removing analytics cookies after a refusal', () => {
  it('finds the GA cookies and leaves the basket and other cookies alone', () => {
    expect(
      analyticsCookieNames('cart_id=abc; _ga=GA1.1.1; _ga_3RJWFM59VV=GS1.1; _gid=x; _gat_UA=1; other=2'),
    ).toEqual(['_ga', '_ga_3RJWFM59VV', '_gid', '_gat_UA']);
    expect(analyticsCookieNames('')).toEqual([]);
  });

  it('covers the host and each parent domain GA may have used', () => {
    expect(cookieDomainsFor('filament.cleverdeals.net')).toEqual([
      'filament.cleverdeals.net',
      '.filament.cleverdeals.net',
      '.cleverdeals.net',
    ]);
    expect(cookieDomainsFor('localhost')).toEqual(['localhost']);
    expect(cookieDomainsFor('127.0.0.1')).toEqual(['127.0.0.1']);
  });
});
