/**
 * Conversational search results page.
 *
 * Reads `?q=...` from the URL, hits the API's `/storefront/search`
 * endpoint, and renders the products in a grid. The LLM's
 * interpretation text sits above the grid so the customer can see
 * what the system thought they meant — and if they disagree, the
 * search bar in the header is one click away.
 *
 * Server-rendered for SEO + zero-flash. force-dynamic because
 * results are per-query.
 */
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { searchProducts, type SearchResultProduct } from '@/lib/smmta';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const qp = await searchParams;
  const q = firstValue(qp.q) ?? '';
  return {
    title: q ? `Search: ${q}` : 'Search',
    robots: { index: false, follow: true },
  };
}

export default async function SearchPage({ searchParams }: PageProps) {
  const qp = await searchParams;
  const query = firstValue(qp.q)?.trim() ?? '';

  if (!query) {
    return <EmptyState />;
  }

  let result: Awaited<ReturnType<typeof searchProducts>> | null = null;
  try {
    result = await searchProducts(query);
  } catch {
    result = null;
  }

  if (!result) {
    return (
      <div className="space-y-3">
        <SearchHeader query={query} />
        <p className="border-y border-[var(--brand-border)] py-10 text-center text-sm text-[var(--brand-muted)]">
          Search failed. Try again, or browse the categories from the Shop menu.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SearchHeader
        query={query}
        interpretation={result.interpretation}
        totalCount={result.totalCount}
        llmBypassed={result.llmBypassed}
        confidence={result.confidence}
      />

      {result.products.length === 0 ? (
        <div className="space-y-4 border-y border-[var(--brand-border)] py-10 text-center text-sm text-[var(--brand-muted)]">
          <p>
            We couldn't find anything matching &ldquo;{query}&rdquo;. Try a different phrasing, or
            pick a category from the Shop menu.
          </p>
          {result.parsed?.categorySlug && (
            <p>
              <Link
                href={`/shop/c/${result.parsed.categorySlug}`}
                className="font-semibold text-[var(--brand-accent)] hover:underline"
              >
                Browse {result.parsed.categorySlug.replace('/', ' / ')} →
              </Link>
            </p>
          )}
        </div>
      ) : (
        <ul className="grid gap-px bg-[var(--brand-border)] sm:grid-cols-2 lg:grid-cols-3">
          {result.products.map((p) => (
            <li key={p.id} className="bg-[var(--brand-paper)]">
              <ProductCard product={p} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SearchHeader({
  query,
  interpretation,
  totalCount,
  llmBypassed,
  confidence,
}: {
  query: string;
  interpretation?: string;
  totalCount?: number;
  llmBypassed?: boolean;
  confidence?: 'high' | 'medium' | 'low' | null;
}) {
  return (
    <header className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
        Search
      </p>
      <h1
        className="text-3xl font-bold tracking-tight md:text-4xl"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        &ldquo;{query}&rdquo;
      </h1>
      {interpretation && (
        <p className="max-w-2xl text-sm text-[var(--brand-muted)]">
          {interpretation}
          {totalCount !== undefined && (
            <span className="ml-2 font-mono text-xs">({totalCount} matches)</span>
          )}
        </p>
      )}
      {llmBypassed && (
        <p className="text-xs italic text-[var(--brand-muted)]">
          Showing keyword matches — conversational parsing was skipped.
        </p>
      )}
      {confidence === 'low' && (
        <p className="text-xs italic text-[var(--brand-muted)]">
          Not confident we matched what you wanted — try rephrasing, or browse the categories.
        </p>
      )}
    </header>
  );
}

function EmptyState() {
  return (
    <div className="space-y-4 border-y border-[var(--brand-border)] py-16 text-center">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
        Search
      </p>
      <h1 className="text-2xl font-bold">What are you looking for?</h1>
      <p className="text-sm text-[var(--brand-muted)]">
        Use the search bar above. Describe what you want — colour, size, occasion, price —
        and we'll find the closest matches.
      </p>
    </div>
  );
}

function ProductCard({ product }: { product: SearchResultProduct }) {
  const href = product.slug ? `/shop/p/${product.slug}` : '/shop';
  const price = product.priceGbp ? `£${product.priceGbp}` : null;
  const showOosBadge = product.stockState === 'OUT_OF_STOCK';
  return (
    <Link
      href={href}
      className="group block h-full transition-colors hover:bg-[var(--brand-bone)]"
    >
      <div className="relative aspect-square overflow-hidden bg-[var(--brand-bone)]">
        {product.heroImageUrl ? (
          <Image
            src={product.heroImageUrl}
            alt={product.name}
            width={400}
            height={400}
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs uppercase tracking-wider text-[var(--brand-muted)]">
            No image
          </div>
        )}
        {showOosBadge && (
          <span className="absolute right-3 top-3 border border-[var(--brand-ink)] bg-[var(--brand-paper)] px-2 py-1 text-[10px] font-semibold uppercase tracking-wider">
            Out of stock
          </span>
        )}
      </div>
      <div className="space-y-1 p-4">
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug">{product.name}</h3>
        {price && <p className="text-sm font-semibold text-[var(--brand-accent)]">{price}</p>}
      </div>
    </Link>
  );
}
