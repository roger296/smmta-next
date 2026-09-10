/**
 * Downloading a product image from a URL into local storage.
 *
 * Pasting a URL used to store the URL. The storefront then re-fetched that
 * third party's image whenever its cache was cold, so the catalogue depended on
 * hosts nobody here controls — and when eBay swapped a batch of listing images
 * for a "no longer available" placeholder, sixteen product pages changed
 * picture with no code change and nothing in any log. Pasting a URL now copies
 * the bytes here once; everything after that is served from this server.
 *
 * It also removes a silent failure: next/image only renders remote hosts on a
 * build-time allow-list, so a URL from anywhere else saved happily and never
 * displayed. A local copy is on our own origin, so any source works.
 *
 * SECURITY. This makes the server fetch a URL chosen by the caller, which is a
 * server-side request forgery primitive: this process sits on the Docker
 * network alongside Postgres, and cloud hosts expose credentials on
 * 169.254.169.254. The route is admin-only, but that is one control and not a
 * reason to skip the rest. So every hop is resolved and checked against private
 * address space before the connection is made, redirects are followed manually
 * so a public URL cannot bounce to an internal one, and the response is capped
 * and timed out.
 */
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { ALLOWED_IMAGE_TYPES, MAX_UPLOAD_BYTES, publicUrlFor, uploadsDir } from './image-upload.routes.js';

/** Redirect hops to follow. Enough for the usual CDN shuffle, not a loop. */
const MAX_REDIRECTS = 3;

/** Whole-request budget. A slow host must not tie up a connection forever. */
const FETCH_TIMEOUT_MS = 15_000;

export class RemoteImageError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'RemoteImageError';
    this.status = status;
  }
}

/**
 * True for addresses that must never be fetched: loopback, link-local (which
 * includes the cloud metadata endpoint), private ranges, and the rest of the
 * space that has no business hosting a product photograph.
 */
export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 0) return true; // Not an address at all — refuse.

  if (version === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts as [number, number, number, number];
    if (a === 0) return true; // "this" network
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 192 && b === 0) return true; // IETF protocol assignments
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped (::ffff:10.0.0.1) would otherwise slip past the v6 checks.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isBlockedAddress(mapped[1]!);
  if (/^f[cd]/.test(lower)) return true; // unique local
  if (/^fe[89ab]/.test(lower)) return true; // link-local
  return false;
}

/** Rejects anything that is not a plain http(s) URL we are willing to fetch. */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RemoteImageError(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RemoteImageError(`Only http and https URLs can be downloaded, got ${url.protocol}`);
  }
  return url;
}

/** Resolves the host and refuses if it points anywhere internal. */
async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw new RemoteImageError(`Refusing to fetch an internal address: ${host}`);
    }
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new RemoteImageError(`Could not resolve ${host}`);
  }
  // Every address, not just the first: a host that resolves to one public and
  // one internal address must not be fetchable at all.
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new RemoteImageError(`Refusing to fetch ${host}: it resolves to an internal address`);
    }
  }
}

/**
 * Fetches the URL, following redirects by hand so each hop is checked. Node's
 * automatic redirect handling would let a public URL forward to an internal
 * one after the guard had already passed.
 */
async function fetchFollowingRedirects(start: URL, signal: AbortSignal): Promise<Response> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url);
    const res = await fetch(url, { redirect: 'manual', signal });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new RemoteImageError(`Redirect from ${url.href} with no location`);
      url = new URL(location, url);
      assertFetchableUrl(url.href);
      continue;
    }
    if (!res.ok) {
      throw new RemoteImageError(`Source returned ${res.status} for ${url.href}`, 502);
    }
    return res;
  }
  throw new RemoteImageError(`Too many redirects from ${start.href}`);
}

/**
 * Downloads an image and returns the public URL of the stored copy.
 * Throws RemoteImageError with a message fit to show an operator.
 */
export async function downloadImageToUploads(rawUrl: string): Promise<string> {
  const url = assertFetchableUrl(rawUrl);
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchFollowingRedirects(url, signal);
  } catch (err) {
    if (err instanceof RemoteImageError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new RemoteImageError(`Could not download ${url.href}: ${reason}`, 502);
  }

  // Content-Type decides the extension, exactly as it does for a file upload,
  // so the URL path cannot choose what lands on disk either.
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const ext = ALLOWED_IMAGE_TYPES[contentType];
  if (!ext) {
    throw new RemoteImageError(
      `${url.href} returned "${contentType || 'no content type'}", not an image we accept. ` +
        `Allowed: ${Object.keys(ALLOWED_IMAGE_TYPES).join(', ')}`,
      415,
    );
  }

  // Check the declared length first, then enforce it again while reading —
  // Content-Length is a claim, and a chunked response has none at all.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    throw new RemoteImageError(
      `${url.href} is ${Math.round(declared / 1024 / 1024)}MB; the limit is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`,
      413,
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) {
    throw new RemoteImageError(`${url.href} returned an empty response`, 502);
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new RemoteImageError(
      `${url.href} is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit`,
      413,
    );
  }

  const filename = `${randomUUID()}${ext}`;
  const dir = uploadsDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), buffer);
  return publicUrlFor(filename);
}

/**
 * True when the URL already points at this server's own upload store, in which
 * case there is nothing to copy. Guards against re-downloading our own file
 * into a second identical one each time an image is re-saved.
 */
export function isAlreadyLocal(rawUrl: string, appBaseUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const base = new URL(appBaseUrl);
    return url.host === base.host && url.pathname.startsWith('/uploads/');
  } catch {
    return false;
  }
}
