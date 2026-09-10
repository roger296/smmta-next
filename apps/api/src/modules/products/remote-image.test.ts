/**
 * Guards on downloading an image from a caller-supplied URL.
 *
 * These are the tests that matter most in this module. Fetching a URL the
 * caller chooses turns the API into a request forgery primitive: it sits on the
 * Docker network with Postgres, and cloud hosts serve credentials on
 * 169.254.169.254. The route is admin-only, but that is one control, and a
 * blocklist with a hole in it is worse than none because it reads as though it
 * were handled.
 */
import { describe, expect, it } from 'vitest';
import { RemoteImageError, assertFetchableUrl, isAlreadyLocal, isBlockedAddress } from './remote-image.js';

describe('isBlockedAddress', () => {
  it('blocks loopback', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('127.255.255.254')).toBe(true);
    expect(isBlockedAddress('::1')).toBe(true);
  });

  it('blocks the cloud metadata endpoint', () => {
    // The single most valuable target: on most cloud hosts this serves
    // instance credentials to anything that can make an HTTP request.
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('169.254.0.1')).toBe(true);
  });

  it('blocks RFC1918 private ranges', () => {
    for (const ip of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('does not over-block the 172.x addresses that are public', () => {
    // 172.16-31 is private; 172.15 and 172.32 are not. An over-broad check
    // would quietly refuse legitimate hosts.
    expect(isBlockedAddress('172.15.0.1')).toBe(false);
    expect(isBlockedAddress('172.32.0.1')).toBe(false);
  });

  it('blocks other reserved space', () => {
    for (const ip of ['0.0.0.0', '100.64.0.1', '192.0.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('blocks IPv4-mapped IPv6, which would otherwise slip past', () => {
    // ::ffff:10.0.0.1 is 10.0.0.1 wearing a hat. Checking only the v6 prefixes
    // would let every private v4 address through this way.
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::FFFF:192.168.0.1')).toBe(true);
  });

  it('blocks IPv6 unique-local and link-local', () => {
    expect(isBlockedAddress('fc00::1')).toBe(true);
    expect(isBlockedAddress('fd12:3456::1')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it('refuses anything that is not an address at all', () => {
    // Fail closed: an unparseable value must not be treated as public.
    expect(isBlockedAddress('')).toBe(true);
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('999.999.999.999')).toBe(true);
  });
});

describe('assertFetchableUrl', () => {
  it('accepts http and https', () => {
    expect(assertFetchableUrl('https://example.com/a.png').hostname).toBe('example.com');
    expect(assertFetchableUrl('http://example.com/a.png').hostname).toBe('example.com');
  });

  it('rejects schemes that could read local resources', () => {
    // file: would read the server's disk; data: would bypass the fetch
    // entirely; gopher: is a classic protocol-smuggling vector.
    for (const url of ['file:///etc/passwd', 'data:image/png;base64,AAA', 'gopher://x/', 'ftp://x/a.png']) {
      expect(() => assertFetchableUrl(url), url).toThrow(RemoteImageError);
    }
  });

  it('rejects nonsense', () => {
    expect(() => assertFetchableUrl('not a url')).toThrow(RemoteImageError);
    expect(() => assertFetchableUrl('')).toThrow(RemoteImageError);
  });
});

describe('isAlreadyLocal', () => {
  const BASE = 'https://api.cleverdeals.net';

  it('recognises our own upload URLs', () => {
    expect(isAlreadyLocal(`${BASE}/uploads/abc.jpg`, BASE)).toBe(true);
  });

  it('does not treat another host as local', () => {
    expect(isAlreadyLocal('https://evil.example/uploads/abc.jpg', BASE)).toBe(false);
  });

  it('does not treat another path on our host as an upload', () => {
    expect(isAlreadyLocal(`${BASE}/api/v1/products`, BASE)).toBe(false);
  });

  it('returns false for an unparseable URL rather than throwing', () => {
    expect(isAlreadyLocal('not a url', BASE)).toBe(false);
  });
});
