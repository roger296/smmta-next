/**
 * Conversational search results page.
 *
 * Reads `?q=...` from the URL, hits the API's `/storefront/search`
 * endpoint, and renders the results in a grid — one card per range, as
 * on the category pages. The LLM's interpretation text sits above the
 * grid so the customer can see what the system thought they meant — and
 * if they disagree, the search bar in the header is one click away.
 *
 * Server-rendered for SEO + zero-flash. force-dynamic because
 * results are per-query.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { searchProducts } from '@/lib/smmta';
import { ListingCard } from '../../_components/listing-card';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

/** A parsed filter axis, when the parser returned a list of strings. */
function stringList(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((s) => typeof s === 'string') ? (v as string[]) : null;
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

  const chosenColours = stringList(result.parsed?.filters.colour);
  const chosenSizes = stringList(result.parsed?.filters.size);

  return (
    <div className="space-y-6">
      <SearchHeader
        query={query}
        interpretation={result.interpretation}
        totalCount={result.totalCount}
        llmBypassed={result.llmBypassed}
        confidence={result.confidence}
      />

      {result.listings.length === 0 ? (
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
          {result.listings.map((l) => (
            <li key={`${l.kind}:${l.id}`} className="bg-[var(--brand-paper)]">
              <ListingCard listing={l} chosenColours={chosenColours} chosenSizes={chosenSizes} />
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
