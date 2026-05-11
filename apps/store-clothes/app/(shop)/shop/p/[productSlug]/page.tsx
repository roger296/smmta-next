/**
 * Standalone product page (`/shop/p/[productSlug]`). RSC, revalidate 60s.
 *
 *   - generateMetadata uses seo_title || name etc.
 *   - JSON-LD: Product + Offer + BreadcrumbList
 *   - Same shape as the group page, but with a single variant (no swatch picker)
 *
 * Standalone products keep their own slug path. Grouped variants are
 * primarily reached via /shop/[groupSlug]?colour=…; this route still
 * works for them as a deep link, but the canonical points back to the
 * group page to avoid duplicate content.
 */
import Image from 'next/image';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getProductBySlug, SmmtaApiError } from '@/lib/smmta';
import { getEnv } from '@/lib/env';
import { breadcrumbLd, productLd, stringifyJsonLd } from '@/lib/seo/structured-data';
import { Markdown } from '@/lib/markdown';
import { AddToCartButton } from '@/components/add-to-cart-button';

export const revalidate = 60;

interface RouteParams {
  productSlug: string;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { productSlug } = await params;
  try {
    const product = await getProductBySlug(productSlug);
    // For grouped variants, canonical points at the group page with the
    // colour query, not at this URL — avoids fragmenting search rankings.
    const canonical = product.groupId
      ? null
      : `/shop/p/${product.slug ?? productSlug}`;
    return {
      title: product.seoTitle ?? product.name,
      description: product.seoDescription ?? product.shortDescription ?? undefined,
      keywords: product.seoKeywords ?? undefined,
      alternates: canonical ? { canonical } : undefined,
      robots: { index: !product.groupId, follow: true },
      openGraph: {
        type: 'website',
        url: canonical ?? `/shop/p/${productSlug}`,
        title: product.seoTitle ?? product.name,
        description: product.seoDescription ?? product.shortDescription ?? undefined,
        images: product.heroImageUrl ? [product.heroImageUrl] : undefined,
      },
      twitter: {
        card: 'summary_large_image',
        title: product.seoTitle ?? product.name,
        description: product.seoDescription ?? product.shortDescription ?? undefined,
        images: product.heroImageUrl ? [product.heroImageUrl] : undefined,
      },
    };
  } catch {
    return { title: 'Product', robots: { index: false, follow: true } };
  }
}

export default async function StandaloneProductPage({
  params,
}: {
  params: Promise<RouteParams>;
}) {
  const { productSlug } = await params;
  const env = getEnv();
  const baseUrl = (() => {
    try {
      return new URL(env.STORE_BASE_URL);
    } catch {
      return new URL('http://localhost:3000');
    }
  })();

  let product;
  try {
    product = await getProductBySlug(productSlug);
  } catch (err) {
    if (err instanceof SmmtaApiError && err.status === 404) {
      notFound();
    }
    throw err;
  }

  const url = `/shop/p/${product.slug ?? productSlug}`;
  const productJsonLd = stringifyJsonLd(productLd(baseUrl, product, url));
  const breadcrumb = stringifyJsonLd(
    breadcrumbLd(baseUrl, [
      { name: 'Home', url: '/' },
      { name: 'Shop', url: '/shop' },
      { name: product.name, url },
    ]),
  );

  return (
    <>
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: productJsonLd }}
      />
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: breadcrumb }}
      />

      <nav aria-label="Breadcrumb" className="text-xs uppercase tracking-wider text-[var(--brand-muted)]">
        <ol className="flex flex-wrap gap-2">
          <li>
            <a href="/" className="hover:text-[var(--brand-ink)] transition-colors">
              Home
            </a>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <a href="/shop" className="hover:text-[var(--brand-ink)] transition-colors">
              Shop
            </a>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="text-[var(--brand-ink)]">{product.name}</li>
        </ol>
      </nav>

      <div className="mt-6 grid gap-10 md:grid-cols-2 md:gap-12">
        <div className="space-y-3">
          <div className="aspect-square overflow-hidden border border-[var(--brand-border)] bg-[var(--brand-bone)]">
            {product.heroImageUrl ? (
              <Image
                src={product.heroImageUrl}
                alt={product.colour ? `${product.name} in ${product.colour}` : product.name}
                width={1200}
                height={1200}
                priority
                sizes="(max-width: 768px) 100vw, 50vw"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-xs uppercase tracking-wider text-[var(--brand-muted)]">
                No image
              </div>
            )}
          </div>
          {product.galleryImageUrls && product.galleryImageUrls.length > 0 && (
            <ul className="grid grid-cols-3 gap-2">
              {product.galleryImageUrls.map((u, idx) => (
                <li
                  key={`${u}-${idx}`}
                  className="aspect-square overflow-hidden border border-[var(--brand-border)] bg-[var(--brand-bone)]"
                >
                  <Image
                    src={u}
                    alt={`${product.name} — gallery ${idx + 1}`}
                    width={400}
                    height={400}
                    sizes="(max-width: 768px) 33vw, 16vw"
                    className="h-full w-full object-cover"
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-col gap-6">
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
              Friendly fit · Real sizes
            </p>
            <h1
              className="text-3xl font-bold tracking-tight md:text-4xl"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {product.name}
            </h1>
            {product.shortDescription && (
              <p className="text-base leading-relaxed text-[var(--brand-muted)]">
                {product.shortDescription}
              </p>
            )}
          </div>

          <div className="flex items-baseline gap-4 border-y border-[var(--brand-border)] py-5">
            <p className="text-3xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>
              {product.priceGbp ? `£${product.priceGbp}` : 'Price on request'}
            </p>
            <p className="text-xs uppercase tracking-wider text-[var(--brand-muted)]">
              inc VAT
            </p>
          </div>

          <p
            className={`text-sm font-medium ${
              product.availableQty === 0
                ? 'text-[var(--brand-muted)]'
                : product.availableQty <= 5
                  ? 'text-[var(--brand-accent)]'
                  : 'text-[var(--brand-ink)]'
            }`}
            aria-live="polite"
          >
            {product.availableQty > 0
              ? product.availableQty <= 5
                ? `Only ${product.availableQty} left in stock.`
                : `In stock — ${product.availableQty} available.`
              : 'Out of stock — check back soon.'}
          </p>

          <AddToCartButton
            productId={product.id}
            inStock={product.availableQty > 0}
          />
        </div>
      </div>

      {product.longDescription && (
        <section className="mt-12 max-w-2xl border-t border-[var(--brand-border)] pt-10">
          <Markdown source={product.longDescription} />
        </section>
      )}
    </>
  );
}
