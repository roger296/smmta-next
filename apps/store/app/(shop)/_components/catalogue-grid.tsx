'use client';

/**
 * Catalogue grid + colour / price / text filters.
 *
 * Filtering is client-side over the already-fetched groups — no extra
 * requests — but the filter STATE lives in the URL. That was the fix for
 * three separate audit findings at once: a filtered view can now be
 * shared and bookmarked, the Back button undoes a filter, and there are
 * real URLs for Google to index.
 *
 * The URL is written with the native History API rather than Next's
 * router. `/shop` is force-dynamic, so `router.replace` would refetch
 * the whole catalogue on every chip press; `history.replaceState` moves
 * the address bar without a round trip. Initial state comes from the
 * server as props, so there's no useSearchParams hook and no Suspense
 * boundary needed.
 *
 * Visual treatment matches the home page Featured grid: groups arranged
 * on a 1px-gap steel backdrop so the gaps become hairline dividers.
 */
import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type { GroupListItem, ThinVariant } from '@/lib/api-types';

export interface CatalogueGridProps {
  groups: GroupListItem[];
  /** Pre-computed catalogue-wide price extents for the slider. */
  priceMin: number;
  priceMax: number;
  /** Pre-computed unique colour list across the whole catalogue. */
  colourOptions: string[];
  /** Filter state parsed from the query string by the server. */
  initialColour?: string | null;
  initialMaxPrice?: number | null;
  initialQuery?: string | null;
}

/** Cards above this index don't get a priority image hint — only the
 *  first row is above the fold, and marking everything priority is the
 *  same as marking nothing. */
const PRIORITY_CARD_COUNT = 3;

export function CatalogueGrid({
  groups,
  priceMin,
  priceMax,
  colourOptions,
  initialColour = null,
  initialMaxPrice = null,
  initialQuery = null,
}: CatalogueGridProps) {
  const [colour, setColour] = React.useState<string | null>(
    initialColour && colourOptions.includes(initialColour) ? initialColour : null,
  );
  const [maxPrice, setMaxPrice] = React.useState<number>(
    initialMaxPrice != null && initialMaxPrice >= priceMin && initialMaxPrice <= priceMax
      ? initialMaxPrice
      : priceMax,
  );
  const [query, setQuery] = React.useState<string>(initialQuery ?? '');
  /** Mobile only — the filter panel is a disclosure under 768px. */
  const [filtersOpen, setFiltersOpen] = React.useState(false);

  // Mirror filter state into the query string. replaceState for the
  // slider and search box (dragging a slider shouldn't write 40 history
  // entries); pushState for the colour chips, so Back genuinely undoes a
  // colour choice — the interaction people expect to be reversible.
  const syncUrl = React.useCallback(
    (next: { colour: string | null; maxPrice: number; query: string }, push: boolean) => {
      if (typeof window === 'undefined') return;
      const params = new URLSearchParams(window.location.search);
      if (next.colour) params.set('colour', next.colour);
      else params.delete('colour');
      if (next.maxPrice < priceMax) params.set('maxPrice', String(next.maxPrice));
      else params.delete('maxPrice');
      if (next.query.trim()) params.set('q', next.query.trim());
      else params.delete('q');
      const qs = params.toString();
      const url = qs ? window.location.pathname + '?' + qs : window.location.pathname;
      if (push) window.history.pushState(null, '', url);
      else window.history.replaceState(null, '', url);
    },
    [priceMax],
  );

  // Back/forward must actually change what's on screen, not just the URL.
  React.useEffect(() => {
    const onPop = () => {
      const params = new URLSearchParams(window.location.search);
      const c = params.get('colour');
      setColour(c && colourOptions.includes(c) ? c : null);
      const mp = Number(params.get('maxPrice'));
      setMaxPrice(Number.isFinite(mp) && mp > 0 ? mp : priceMax);
      setQuery(params.get('q') ?? '');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [colourOptions, priceMax]);

  const applyColour = (next: string | null) => {
    setColour(next);
    syncUrl({ colour: next, maxPrice, query }, true);
  };
  const applyMaxPrice = (next: number) => {
    setMaxPrice(next);
    syncUrl({ colour, maxPrice: next, query }, false);
  };
  const applyQuery = (next: string) => {
    setQuery(next);
    syncUrl({ colour, maxPrice, query: next }, false);
  };

  const normalisedQuery = query.trim().toLowerCase();

  const filtered = React.useMemo(() => {
    return groups
      .map((g) => {
        const matchingVariants = g.variants.filter((v) => {
          if (colour && v.colour !== colour) return false;
          if (v.priceGbp) {
            const p = Number.parseFloat(v.priceGbp);
            if (Number.isFinite(p) && p > maxPrice) return false;
          }
          return true;
        });
        if (matchingVariants.length === 0) return null;

        // Free-text match across the group name, its description, and the
        // colour names of its variants — so "petg" finds the range and
        // "sky blue" finds the ranges that stock it. Every term must be
        // present, so adding a word narrows rather than widens.
        if (normalisedQuery) {
          const haystack = [
            g.name,
            g.shortDescription ?? '',
            ...matchingVariants.map((v) => v.colour ?? ''),
          ]
            .join(' ')
            .toLowerCase();
          const everyTermPresent = normalisedQuery
            .split(/\s+/)
            .every((term) => haystack.includes(term));
          if (!everyTermPresent) return null;
        }
        return { group: g, matchingVariants };
      })
      .filter((g): g is { group: GroupListItem; matchingVariants: ThinVariant[] } => g !== null);
  }, [groups, colour, maxPrice, normalisedQuery]);

  const activeFilterCount =
    (colour ? 1 : 0) + (maxPrice < priceMax ? 1 : 0) + (normalisedQuery ? 1 : 0);

  const clearAll = () => {
    setColour(null);
    setMaxPrice(priceMax);
    setQuery('');
    syncUrl({ colour: null, maxPrice: priceMax, query: '' }, true);
  };

  const filterPanelClass = [
    filtersOpen ? 'block' : 'hidden',
    'space-y-5 border border-[var(--brand-border)] bg-[var(--brand-bone)] p-5 md:block',
  ].join(' ');

  return (
    <div className="space-y-6">
      {/*
        UX 01: on a 375px handset the filter panel was 861px tall, so the
        first product card started below the fold and a mobile visitor
        landing on the category page saw a filter panel and no filament.
        Under 768px it collapses to a single button carrying the active
        count; from md up the panel is always open, exactly as before.
      */}
      <div className="md:hidden">
        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          aria-expanded={filtersOpen}
          aria-controls="catalogue-filters"
          className="flex min-h-11 w-full items-center justify-between border border-[var(--brand-border)] bg-[var(--brand-bone)] px-4 text-sm font-semibold uppercase tracking-wider"
        >
          <span>
            Filter
            {activeFilterCount > 0 && (
              <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center bg-[var(--brand-accent)] px-1.5 text-xs text-[var(--brand-paper)]">
                {activeFilterCount}
              </span>
            )}
          </span>
          <span aria-hidden="true">{filtersOpen ? '−' : '+'}</span>
        </button>
      </div>

      <div id="catalogue-filters" className={filterPanelClass}>
        <div className="flex flex-wrap items-end gap-6">
          <fieldset className="min-w-[220px] flex-1">
            <legend className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--brand-ink)]">
              Search
            </legend>
            <input
              type="search"
              value={query}
              onChange={(e) => applyQuery(e.target.value)}
              placeholder="petg, matte black, sky blue…"
              aria-label="Search the range"
              className="mt-3 min-h-11 w-full border border-[var(--brand-border)] bg-[var(--brand-paper)] px-3 text-sm focus-visible:border-[var(--brand-ink)] focus-visible:outline-none"
            />
          </fieldset>

          <fieldset className="min-w-[220px] flex-1">
            <legend className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--brand-ink)]">
              Max price{' '}
              <span className="font-mono font-normal text-[var(--brand-muted)]">
                · £{maxPrice.toFixed(2)}
              </span>
            </legend>
            <input
              type="range"
              min={priceMin}
              max={priceMax}
              step={1}
              value={maxPrice}
              onChange={(e) => applyMaxPrice(Number(e.target.value))}
              className="mt-3 h-11 w-full accent-[var(--brand-accent)]"
              aria-label="Maximum price"
            />
          </fieldset>
        </div>

        <fieldset>
          <legend className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--brand-ink)]">
            Colour
          </legend>
          <div className="mt-3 flex flex-wrap gap-2">
            <FilterChip label="All" active={colour === null} onClick={() => applyColour(null)} />
            {colourOptions.map((c) => (
              <FilterChip key={c} label={c} active={colour === c} onClick={() => applyColour(c)} />
            ))}
          </div>
        </fieldset>

        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={clearAll}
            className="min-h-11 text-xs font-semibold uppercase tracking-wider text-[var(--brand-accent)] hover:underline"
          >
            Clear all filters
          </button>
        )}
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <p className="border-y border-[var(--brand-border)] py-10 text-center text-sm text-[var(--brand-muted)]">
          No products match those filters. Reset the colour or price range to see more.
        </p>
      ) : (
        <>
          <p className="sr-only" role="status" aria-live="polite">
            {filtered.length} {filtered.length === 1 ? 'range' : 'ranges'} shown
          </p>
          <ul className="grid gap-px bg-[var(--brand-border)] sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map(({ group, matchingVariants }, i) => (
              <li key={group.id} className="bg-[var(--brand-paper)]">
                <CatalogueCard
                  group={group}
                  activeColour={colour}
                  matchingVariants={matchingVariants}
                  priority={i < PRIORITY_CARD_COUNT}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  // min-h-11 (44px) is the iOS / WCAG touch floor. The chip's visual
  // height is unchanged — the padding does the work — so the design
  // reads the same while the hit area stops being 30px on a handset.
  const base =
    'inline-flex min-h-11 items-center px-3 py-1.5 text-xs uppercase tracking-wider transition-colors';
  const className = active
    ? base + ' border border-[var(--brand-ink)] bg-[var(--brand-ink)] font-semibold text-[var(--brand-paper)]'
    : base + ' border border-[var(--brand-border)] bg-[var(--brand-paper)] font-medium hover:border-[var(--brand-ink)]';
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={className}>
      {label}
    </button>
  );
}

function CatalogueCard({
  group,
  activeColour,
  matchingVariants,
  priority,
}: {
  group: GroupListItem;
  activeColour: string | null;
  matchingVariants: ThinVariant[];
  priority: boolean;
}) {
  // Bug 09: filtering to Black and clicking a card used to land on the
  // group's default colour (Beige), making the customer re-select the
  // swatch they had just chosen. With a colour filter active we link
  // straight to that variant's own page — now indexable and
  // self-canonical — falling back to the group's ?colour= toggle when
  // the variant has no slug of its own.
  const activeVariant = activeColour
    ? matchingVariants.find((v) => v.colour === activeColour)
    : undefined;
  const groupHref = group.slug
    ? activeColour
      ? '/shop/' + group.slug + '?colour=' + encodeURIComponent(activeColour)
      : '/shop/' + group.slug
    : '/shop';
  const href = activeVariant?.slug ? '/shop/p/' + activeVariant.slug : groupHref;

  const priceFrom = group.priceRange
    ? group.priceRange.min === group.priceRange.max
      ? `£${group.priceRange.min}`
      : `£${group.priceRange.min} – £${group.priceRange.max}`
    : null;
  // "Out of stock" only when EVERY variant is OOS from EVERY source
  // (warehouse + supplier). Using `totalAvailableQty === 0` alone would
  // flag every dropship product as OOS — dropship products never carry
  // warehouse stock, even when the supplier has thousands of units.
  //
  // Three states:
  //   IN_STOCK                — we have warehouse stock (or the variant has none, but the others do)
  //   AVAILABLE_FROM_SUPPLIER — no warehouse but the supplier has stock
  //   OUT_OF_STOCK            — neither source has any
  // The badge fires only when ALL variants are in the last bucket.
  const outOfStock =
    group.variants.length > 0 && group.variants.every((v) => v.stockState === 'OUT_OF_STOCK');

  return (
    <Link href={href} className="group block h-full transition-colors hover:bg-[var(--brand-bone)]">
      <div className="relative aspect-square overflow-hidden bg-[var(--brand-bone)]">
        {group.heroImageUrl ? (
          <Image
            src={group.heroImageUrl}
            alt={activeColour ? `${group.name} — ${activeColour}` : group.name}
            width={800}
            height={800}
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            // SEO 14: the first row is the mobile LCP element. `priority`
            // emits fetchpriority="high" plus a preload; without it the
            // hero rendered at ~504ms with no hint at all.
            priority={priority}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs uppercase tracking-wider text-[var(--brand-muted)]">
            No image
          </div>
        )}
        {outOfStock && (
          <span className="absolute right-3 top-3 border border-[var(--brand-ink)] bg-[var(--brand-paper)] px-2 py-1 text-[10px] font-semibold uppercase tracking-wider">
            Out of stock
          </span>
        )}
      </div>
      <div className="space-y-2 p-5">
        <h3 className="text-base font-semibold leading-snug">
          {group.name}
          {activeColour && <span className="text-[var(--brand-accent)]"> — {activeColour}</span>}
        </h3>
        {group.shortDescription && (
          <p className="line-clamp-2 text-sm text-[var(--brand-muted)]">{group.shortDescription}</p>
        )}
        {priceFrom && (
          <p className="pt-1 text-sm font-semibold text-[var(--brand-accent)]">
            {activeVariant?.priceGbp ? `£${activeVariant.priceGbp}` : `From ${priceFrom}`}
          </p>
        )}
      </div>
    </Link>
  );
}
