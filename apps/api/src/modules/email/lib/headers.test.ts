import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetEnvForTests } from '../../../config/env.js';
import { marketingHeaders, preferencesUrl, unsubscribeUrl } from './headers.js';
import { signedLink, verifySignedLink } from './tokens.js';

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe('marketingHeaders (RFC 2369 / RFC 8058)', () => {
  it('lists the https URL and the mailto, angle-bracketed and comma-separated, and the one-click POST value verbatim', () => {
    vi.stubEnv('STOREFRONT_BASE_URL', 'https://shop.example.com/');
    vi.stubEnv('EMAIL_UNSUBSCRIBE_MAILTO', 'unsubscribe@example.com');
    resetEnvForTests();
    const h = marketingHeaders({ unsubscribeToken: 'abc_DEF-123' });
    expect(h['List-Unsubscribe']).toBe(
      '<https://shop.example.com/email/u/abc_DEF-123>, <mailto:unsubscribe@example.com?subject=abc_DEF-123>',
    );
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(Object.keys(h)).toEqual(['List-Unsubscribe', 'List-Unsubscribe-Post']);
    expect(h['List-Unsubscribe']).toMatch(/^<https:\/\/[^>]+>, <mailto:[^>]+>$/);
  });

  it('builds the page URLs on the storefront origin', () => {
    vi.stubEnv('STOREFRONT_BASE_URL', 'https://shop.example.com');
    resetEnvForTests();
    expect(unsubscribeUrl('t')).toBe('https://shop.example.com/email/u/t');
    expect(preferencesUrl('t')).toBe('https://shop.example.com/email/preferences/t');
  });
});

describe('signed links', () => {
  it('round-trips, rejects tampering and expires', () => {
    const now = Date.parse('2026-11-05T00:00:00Z');
    const t = signedLink({ sku: 'ABC', qty: 2 }, 30 * 86_400, now);
    expect(verifySignedLink(t, now + 1000)).toMatchObject({ sku: 'ABC', qty: 2 });
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ sku: 'ABC', qty: 200, exp: 9_999_999_999 })).toString('base64url');
    expect(verifySignedLink(`${forged}.${sig}`, now)).toBeNull();
    expect(verifySignedLink(`${body}.${sig}x`, now)).toBeNull();
    expect(verifySignedLink(t, now + 31 * 86_400_000)).toBeNull();
    expect(verifySignedLink('garbage', now)).toBeNull();
  });
});
