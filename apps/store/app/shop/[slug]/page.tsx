/**
 * Product detail page (SPEC F1, §15.1a). Shows the variant, its warehouse buy
 * box (via AddToCartButton, which falls back to Notify-Me when out of stock),
 * and the inbound pre-order pools with £ savings (<PreorderPools/>). Pricing is
 * £-only; pre-order options come straight from the pricing engine.
 */
import type { Metadata } from 'next';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { getProductBySlug, SmmtaApiError } from '@/lib/smmta';
import { AddToCartButton } from '@/components/add-to-cart-button';
import { PreorderPools } from '@/components/preorder-pools';
import { WatchOffersButton } from '@/components/watch-offers-button';

export const revalidate = 60;

async function loadProduct(slug: string) {
  try {
    return await getProductBySlug(slug);
  } catch (err) {
    if (err instanceof SmmtaApiError && err.status === 404) return null;
    throw err;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const product = await loadProduct(slug);
  if (!product) return { title: 'Not found' };
  return {
    title: product.seoTitle ?? product.name,
    description: product.seoDescription ?? product.shortDescription ?? undefined,
  };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const product = await loadProduct(slug);
  if (!product) notFound();

  const inStock = product.availableQty > 0;
  const price = product.priceGbp ? `£${Number(product.priceGbp).toFixed(2)}` : null;

  return (
    <article className="grid grid-cols-1 gap-10 md:grid-cols-2">
      <div className="relative aspect-square overflow-hidden border border-[var(--brand-border)] bg-[var(--brand-bone)]">
        {product.heroImageUrl ? (
          <Image src={product.heroImageUrl} alt={product.name} fill sizes="(max-width: 768px) 100vw, 50vw" className="object-cover" priority />
        ) : (
          <div className="flex h-full items-center justify-center text-[var(--brand-muted)]">No image</div>
        )}
      </div>

      <div>
        <h1 className="font-[var(--font-display)] text-2xl font-bold tracking-tight">{product.name}</h1>
        {product.colour && (
          <p className="mt-1 flex items-center gap-2 text-sm text-[var(--brand-muted)]">
            {product.colourHex && (
              <span aria-hidden className="inline-block h-4 w-4 border border-[var(--brand-border)]" style={{ background: product.colourHex }} />
            )}
            {product.colour}
          </p>
        )}
        {price && <p className="mt-4 text-xl font-semibold">{price}</p>}
        <p className="mt-1 text-xs text-[var(--brand-muted)]">1.75mm · 1kg · vacuum-sealed</p>

        <div className="mt-6">
          <AddToCartButton productId={product.id} inStock={inStock} />
          {/* In-stock: offer a "watch for offers" flag (F8 contextual button). */}
          {inStock && <WatchOffersButton sku={product.slug ?? product.id} />}
        </div>

        {/* Warehouse band + inbound pre-order pools with £ savings. */}
        <PreorderPools sku={product.slug ?? product.id} />

        {product.longDescription && (
          <div className="mt-8 border-t border-[var(--brand-border)] pt-6 text-sm leading-relaxed text-[var(--brand-ink)]">
            {product.longDescription}
          </div>
        )}
      </div>
    </article>
  );
}
