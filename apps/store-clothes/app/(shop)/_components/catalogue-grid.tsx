'use client';

/**
 * Catalogue grid + colour / price filters. Client-only filtering on the
 * already-fetched groups — no extra requests.
 *
 * Visual treatment matches the home page Featured grid: groups arranged on a
 * 1px-gap steel-coloured backdrop so the gaps themselves become hairline
 * dividers (no per-card borders needed). Industrial / spec-sheet feel.
 */
import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type { GroupListItem } from '@/lib/api-types';

export interface CatalogueGridProps {
  groups: GroupListItem[];
  /** Pre-computed catalogue-wide price extents for the slider. */
  priceMin: number;
  priceMax: number;
  /** Pre-computed unique colour list across the whole catalogue. */
  colourOptions: string[];
}

export function CatalogueGrid({
  groups,
  priceMin,
  priceMax,
  colourOptions,
}: CatalogueGridProps) {
  const [colour, setColour] = React.useState<string | null>(null);
  const [maxPrice, setMaxPrice] = React.useState<number>(priceMax);

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
        return matchingVariants.length > 0 ? { group: g, variantCount: matchingVariants.length } : null;
      })
      .filter((g): g is { group: GroupListItem; variantCount: number } => g !== null);
  }, [groups, colour, maxPrice]);

  return (
    <div className="space-y-8">
      {/* Filter bar — sits above the grid in a contrasting bone surface. */}
      <div className="flex flex-wrap items-end gap-6 border border-[var(--brand-border)] bg-[var(--brand-bone)] p-5">
        <fieldset>
          <legend className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--brand-ink)]">
            Colour
          </legend>
          <div className="mt-3 flex flex-wrap gap-2">
            <FilterChip
              label="All"
              active={colour === null}
              onClick={() => setColour(null)}
            />
            {colourOptions.map((c) => (
              <FilterChip
                key={c}
                label={c}
                active={colour === c}
                onClick={() => setColour(c)}
              />
            ))}
          </div>
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
            onChange={(e) => setMaxPrice(Number(e.target.value))}
            className="mt-3 w-full accent-[var(--brand-accent)]"
            aria-label="Maximum price"
          />
        </fieldset>
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <p className="border-y border-[var(--brand-border)] py-10 text-center text-sm text-[var(--brand-muted)]">
          No products match those filters. Reset the colour or price range to see more.
        </p>
      ) : (
        <ul className="grid gap-px bg-[var(--brand-border)] sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map(({ group }) => (
            <li key={group.id} className="bg-[var(--brand-paper)]">
              <CatalogueCard group={group} />
            </li>
          ))}
        </ul>
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
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        active
          ? 'border border-[var(--brand-ink)] bg-[var(--brand-ink)] px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--brand-paper)] transition-colors'
          : 'border border-[var(--brand-border)] bg-[var(--brand-paper)] px-3 py-1.5 text-xs font-medium uppercase tracking-wider transition-colors hover:border-[var(--brand-ink)]'
      }
    >
      {label}
    </button>
  );
}

function CatalogueCard({ group }: { group: GroupListItem }) {
  const href = group.slug ? `/shop/${group.slug}` : '/shop';
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
  //   AVAILABLE_FROM_SUPPLIER — no warehouse but Uneek has stock
  //   OUT_OF_STOCK            — neither source has any
  // The badge fires only when ALL variants are in the last bucket.
  const outOfStock =
    group.variants.length > 0 &&
    group.variants.every((v) => v.stockState === 'OUT_OF_STOCK');

  return (
    <Link
      href={href}
      className="group block h-full transition-colors hover:bg-[var(--brand-bone)]"
    >
      <div className="relative aspect-square overflow-hidden bg-[var(--brand-bone)]">
        {group.heroImageUrl ? (
          <Image
            src={group.heroImageUrl}
            alt={group.name}
            width={800}
            height={800}
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
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
        <h3 className="text-base font-semibold leading-snug">{group.name}</h3>
        {group.shortDescription && (
          <p className="line-clamp-2 text-sm text-[var(--brand-muted)]">
            {group.shortDescription}
          </p>
        )}
        {priceFrom && (
          <p className="pt-1 text-sm font-semibold text-[var(--brand-accent)]">
            From {priceFrom}
          </p>
        )}
      </div>
    </Link>
  );
}
