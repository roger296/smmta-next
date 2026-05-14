/**
 * Category landing page. Catches both
 *
 *   /shop/c/<top>                e.g. /shop/c/tops
 *   /shop/c/<top>/<sub>          e.g. /shop/c/tops/polo-shirts
 *
 * via the catch-all dynamic segment. Server-rendered (force-dynamic
 * matches the rest of the storefront catalogue surface so DB changes
 * surface immediately, see PR #43).
 *
 * The page calls the storefront API endpoint
 * `GET /storefront/categories/:slugPath/products?<filters>&<sort>&page=N`
 * and hands the response to `CategoryGrid` (client component) for
 * filter form rendering.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { listCategoryProducts } from '@/lib/smmta';
import { breadcrumbLd, stringifyJsonLd } from '@/lib/seo/structured-data';
import { getEnv } from '@/lib/env';
import { CategoryGrid } from '../../../_components/category-grid';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ slug: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// Build the slug path from the catch-all route. Cap to two segments
// (top/sub) — anything deeper is invalid and 404s.
function buildSlugPath(slug: string[]): string | null {
  if (slug.length === 0 || slug.length > 2) return null;
  return slug.filter((s) => s && s.length > 0).join('/');
}

function firstValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const slugPath = buildSlugPath(slug);
  if (!slugPath) return { title: 'Shop' };
  // Don't call the API for metadata — the title is good enough from
  // the slug alone (capitalised + dashes-to-spaces). The page itself
  // does the real fetch.
  const name = slug[slug.length - 1]!.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    title: name,
    description: `${name} at the Clothes Shop — friendly fits, fair prices, fast UK delivery.`,
    alternates: { canonical: `/shop/c/${slugPath}` },
    openGraph: {
      type: 'website',
      url: `/shop/c/${slugPath}`,
      title: `${name} | Clothes Shop`,
    },
    robots: { index: true, follow: true },
  };
}

const PAGE_SIZE = 60;

export default async function CategoryPage({ params, searchParams }: PageProps) {
  const env = getEnv();
  const baseUrl = (() => {
    try {
      return new URL(env.STORE_BASE_URL);
    } catch {
      return new URL('http://localhost:3000');
    }
  })();

  const { slug } = await params;
  const slugPath = buildSlugPath(slug);
  if (!slugPath) notFound();

  const qp = await searchParams;
  const queryArgs = {
    stock: firstValue(qp.stock),
    colour: firstValue(qp.colour),
    size: firstValue(qp.size),
    brand: firstValue(qp.brand),
    price: firstValue(qp.price),
    sort: firstValue(qp.sort),
    page: Number(firstValue(qp.page) ?? '1') || 1,
  };

  let response: Awaited<ReturnType<typeof listCategoryProducts>> | null = null;
  try {
    response = await listCategoryProducts(slugPath, queryArgs);
  } catch (err) {
    // Distinguish 404 (unknown category — show notFound) from any other
    // error (degrade to an empty grid + nudge to /shop). The smmta lib
    // throws SmmtaApiError on failed fetches; we treat anything non-OK
    // as "category absent" because the only realistic 4xx here is the
    // slug not existing.
    if (err && typeof err === 'object' && 'status' in err && (err as { status?: number }).status === 404) {
      notFound();
    }
    response = null;
  }

  if (!response) notFound();

  const { category, products, totalCount, facets } = response;

  const breadcrumbJsonLd = stringifyJsonLd(
    breadcrumbLd(
      baseUrl,
      category.breadcrumbs.map((b) => ({
        name: b.name,
        url: b.path === 'shop' ? '/shop' : `/shop/c/${b.path}`,
      })),
    ),
  );

  return (
    <>
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: breadcrumbJsonLd }}
      />

      <header className="space-y-3">
        <nav aria-label="Breadcrumb" className="text-xs uppercase tracking-wider text-[var(--brand-muted)]">
          <ol className="flex flex-wrap gap-1">
            {category.breadcrumbs.map((b, i) => (
              <li key={b.path} className="flex items-center gap-1">
                {i > 0 && <span aria-hidden="true">/</span>}
                {i < category.breadcrumbs.length - 1 ? (
                  <Link
                    href={b.path === 'shop' ? '/shop' : `/shop/c/${b.path}`}
                    className="hover:text-[var(--brand-ink)]"
                  >
                    {b.name}
                  </Link>
                ) : (
                  <span aria-current="page" className="text-[var(--brand-ink)]">
                    {b.name}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
          Browse
        </p>
        <h1
          className="text-4xl font-bold tracking-tight md:text-5xl"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {category.name}
        </h1>
        {category.description && (
          <p className="max-w-2xl text-base text-[var(--brand-muted)]">{category.description}</p>
        )}
      </header>

      <div className="mt-10">
        <CategoryGrid
          products={products}
          facets={facets}
          totalCount={totalCount}
          slugPath={slugPath}
          page={queryArgs.page}
          pageSize={PAGE_SIZE}
        />
      </div>
    </>
  );
}
