/**
 * Open Graph image URLs on our own domain.
 *
 * Source product imagery lives on app.etailsupport.com, and og:image
 * pointed straight at it — so every social share and Google Images
 * result cited a domain unrelated to the brand. Card images were already
 * proxied through /_next/image; it was only the Open Graph reference
 * that leaked.
 *
 * Routing through the same optimiser keeps the citation on the store's
 * domain, and hands crawlers a correctly-sized image rather than the
 * full-resolution original.
 *
 * Absolute, because Open Graph consumers don't resolve relative URLs —
 * and unlike Next's own metadata handling there's no metadataBase to
 * lean on once the path goes through /_next/image.
 */

/** Width crawlers and social platforms are happiest with. */
const OG_WIDTH = 1200;
const OG_QUALITY = 75;

export function ogImageUrl(sourceUrl: string | null, baseUrl: URL): string | undefined {
  if (!sourceUrl) return undefined;
  // Already ours (a /public asset or an absolute URL on this origin):
  // hand it back absolute and leave it alone.
  if (sourceUrl.startsWith('/')) return new URL(sourceUrl, baseUrl).toString();
  try {
    if (new URL(sourceUrl).origin === baseUrl.origin) return sourceUrl;
  } catch {
    return undefined;
  }
  const optimised = `/_next/image?url=${encodeURIComponent(sourceUrl)}&w=${OG_WIDTH}&q=${OG_QUALITY}`;
  return new URL(optimised, baseUrl).toString();
}
