'use client';

/**
 * Category page grid + filter sidebar (client component).
 *
 * Why client-rendered: filter selections are stored in the URL so
 * deep-links and SEO work, and the page is server-rendered against
 * those URL params. This component handles the *form* — when the
 * customer toggles a filter we update the URL and let the server
 * re-render. No client-side data fetching; the products + facets
 * arrive as props.
 *
 * State lives in the URL search-params (single source of truth);
 * this component reads them via `useSearchParams` and writes via
 * `router.push`. Selections survive page refresh, browser back, and
 * link sharing — all the things `useState`-only filtering misses.
 */
import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { CategoryFacets, CategoryProduct } from '@/lib/smmta';

export interface CategoryGridProps {
  products: CategoryProduct[];
  facets: CategoryFacets;
  totalCount: number;
  /** Slug path the page rendered for — e.g. `tops` or `tops/polo-shirts`.
   *  Used to build the URLs the filter form pushes back to. */
  slugPath: string;
  /** Current page (1-indexed). */
  page: number;
  /** Server-side page size — must match `PAGE_SIZE` in the category
   *  service. Used to compute "Showing 1-60 of 1234". */
  pageSize: number;
}

const STOCK_LABELS: Record<string, string> = {
  IN_STOCK: 'In stock now',
  AVAILABLE_FROM_SUPPLIER: 'Available from supplier',
  OUT_OF_STOCK: 'Out of stock',
};

const STOCK_DEFAULTS = ['IN_STOCK', 'AVAILABLE_FROM_SUPPLIER'];

export function CategoryGrid({
  products,
  facets,
  totalCount,
  slugPath,
  page,
  pageSize,
}: CategoryGridProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  /** Build a URL with one filter axis updated. Pass `null` for `value`
   *  to clear that axis. */
  const buildHref = React.useCallback(
    (key: string, value: string | null): string => {
      const next = new URLSearchParams(searchParams.toString());
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
      // Filter changes always reset to page 1.
      next.delete('page');
      const qs = next.toString();
      return `/shop/c/${slugPath}${qs ? `?${qs}` : ''}`;
    },
    [searchParams, slugPath],
  );

  const navigateTo = React.useCallback(
    (href: string) => {
      router.push(href, { scroll: false });
    },
    [router],
  );

  // Read currently-selected values from the URL.
  const selectedColours = parseCsv(searchParams.get('colour'));
  const selectedSizes = parseCsv(searchParams.get('size'));
  const selectedBrands = parseCsv(searchParams.get('brand'));
  const selectedStock = parseCsv(searchParams.get('stock')) ?? STOCK_DEFAULTS;
  const currentSort = searchParams.get('sort') ?? 'newest';

  // Toggle a single value within a CSV-encoded filter axis.
  const toggleInCsv = (axis: string, value: string, currently: string[]) => {
    const next = currently.includes(value)
      ? currently.filter((v) => v !== value)
      : [...currently, value];
    navigateTo(buildHref(axis, next.length > 0 ? next.join(',') : null));
  };

  // Build pagination links.
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const prevHref = page > 1 ? buildHrefWithPage(searchParams, slugPath, page - 1) : null;
  const nextHref = page < totalPages ? buildHrefWithPage(searchParams, slugPath, page + 1) : null;
  const firstShown = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastShown = Math.min(page * pageSize, totalCount);

  return (
    <div className="grid gap-8 md:grid-cols-[14rem_1fr]">
      {/* Filter sidebar */}
      <aside aria-label="Filters" className="space-y-6 text-sm">
        {/* Sort — top of sidebar so it's always visible */}
        <FilterBlock title="Sort">
          <select
            value={currentSort}
            onChange={(e) => navigateTo(buildHref('sort', e.target.value === 'newest' ? null : e.target.value))}
            className="w-full border border-[var(--brand-border)] bg-[var(--brand-paper)] px-2 py-1.5 text-sm"
            aria-label="Sort products"
          >
            <option value="newest">Newest first</option>
            <option value="price-asc">Price: low to high</option>
            <option value="price-desc">Price: high to low</option>
          </select>
        </FilterBlock>

        {/* Stock state */}
        <FilterBlock title="Availability">
          {(['IN_STOCK', 'AVAILABLE_FROM_SUPPLIER', 'OUT_OF_STOCK'] as const).map((s) => (
            <CheckboxRow
              key={s}
              label={STOCK_LABELS[s]!}
              count={facets.stockState[s] ?? 0}
              checked={selectedStock.includes(s)}
              onToggle={() => toggleInCsv('stock', s, selectedStock)}
            />
          ))}
        </FilterBlock>

        {/* Colour */}
        {Object.keys(facets.colour).length > 0 && (
          <FilterBlock title="Colour">
            {Object.entries(facets.colour)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 12)
              .map(([colour, count]) => (
                <CheckboxRow
                  key={colour}
                  label={colour}
                  count={count}
                  checked={selectedColours?.includes(colour) ?? false}
                  onToggle={() => toggleInCsv('colour', colour, selectedColours ?? [])}
                />
              ))}
          </FilterBlock>
        )}

        {/* Size */}
        {Object.keys(facets.size).length > 0 && (
          <FilterBlock title="Size">
            {Object.entries(facets.size)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 12)
              .map(([size, count]) => (
                <CheckboxRow
                  key={size}
                  label={size}
                  count={count}
                  checked={selectedSizes?.includes(size) ?? false}
                  onToggle={() => toggleInCsv('size', size, selectedSizes ?? [])}
                />
              ))}
          </FilterBlock>
        )}

        {/* Brand */}
        {Object.keys(facets.brand).length > 0 && (
          <FilterBlock title="Brand">
            {Object.entries(facets.brand)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 20)
              .map(([brand, count]) => (
                <CheckboxRow
                  key={brand}
                  label={brand}
                  count={count}
                  checked={selectedBrands?.includes(brand) ?? false}
                  onToggle={() => toggleInCsv('brand', brand, selectedBrands ?? [])}
                />
              ))}
          </FilterBlock>
        )}

        {/* Clear all */}
        {searchParams.toString().length > 0 && (
          <button
            type="button"
            onClick={() => navigateTo(`/shop/c/${slugPath}`)}
            className="text-xs uppercase tracking-wider text-[var(--brand-accent)] hover:underline"
          >
            Clear all filters
          </button>
        )}
      </aside>

      {/* Product grid */}
      <div className="space-y-6">
        <p className="text-sm text-[var(--brand-muted)]">
          {totalCount === 0
            ? 'No products match your filters.'
            : `Showing ${firstShown}–${lastShown} of ${totalCount}`}
        </p>

        {products.length === 0 ? (
          <p className="border-y border-[var(--brand-border)] py-10 text-center text-sm text-[var(--brand-muted)]">
            Nothing matches the current filters. Clear a filter to widen the search.
          </p>
        ) : (
          <ul className="grid gap-px bg-[var(--brand-border)] sm:grid-cols-2 lg:grid-cols-3">
            {products.map((p) => (
              <li key={p.id} className="bg-[var(--brand-paper)]">
                <ProductCard product={p} />
              </li>
            ))}
          </ul>
        )}

        {/* Pagination */}
        {(prevHref || nextHref) && (
          <nav className="flex items-center justify-between border-t border-[var(--brand-border)] pt-4 text-sm">
            <div>
              {prevHref ? (
                <Link href={prevHref} className="font-semibold uppercase tracking-wider hover:text-[var(--brand-accent)]">
                  ← Previous
                </Link>
              ) : (
                <span className="text-[var(--brand-muted)]">← Previous</span>
              )}
            </div>
            <div className="text-[var(--brand-muted)]">
              Page {page} of {totalPages}
            </div>
            <div>
              {nextHref ? (
                <Link href={nextHref} className="font-semibold uppercase tracking-wider hover:text-[var(--brand-accent)]">
                  Next →
                </Link>
              ) : (
                <span className="text-[var(--brand-muted)]">Next →</span>
              )}
            </div>
          </nav>
        )}
      </div>
    </div>
  );
}

function FilterBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-semibold uppercase tracking-[0.15em] text-[var(--brand-ink)]">
        {title}
      </legend>
      <div className="space-y-1.5">{children}</div>
    </fieldset>
  );
}

function CheckboxRow({
  label,
  count,
  checked,
  onToggle,
}: {
  label: string;
  count: number;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="accent-[var(--brand-accent)]"
      />
      <span className="flex-1">{label}</span>
      <span className="text-xs text-[var(--brand-muted)]">{count}</span>
    </label>
  );
}

function ProductCard({ product }: { product: CategoryProduct }) {
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

function parseCsv(v: string | null): string[] | null {
  if (!v) return null;
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

function buildHrefWithPage(
  searchParams: URLSearchParams | ReadonlyURLSearchParams,
  slugPath: string,
  page: number,
): string {
  const next = new URLSearchParams(searchParams.toString());
  if (page > 1) next.set('page', String(page));
  else next.delete('page');
  const qs = next.toString();
  return `/shop/c/${slugPath}${qs ? `?${qs}` : ''}`;
}

// Workaround for next/navigation's ReadonlyURLSearchParams not being
// constructible from this file — we accept the readonly variant in
// the helper above for type compat.
type ReadonlyURLSearchParams = ReturnType<typeof useSearchParams> extends infer T
  ? NonNullable<T>
  : URLSearchParams;
