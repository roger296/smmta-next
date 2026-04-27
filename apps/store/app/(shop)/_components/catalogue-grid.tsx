'use client';

/**
 * Catalogue grid + colour / price filters. Client-only filtering on the
 * already-fetched groups — no extra requests.
 *
 * The group grid is the canonical surface; standalone products surface as
 * single-card "ranges" with one variant.
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-4 rounded-[var(--radius)] border border-[var(--brand-border)] bg-[var(--brand-paper)] p-4">
        <fieldset>
          <legend className="text-sm font-medium">Colour</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setColour(null)}
              aria-pressed={colour === null}
              className={`rounded-full border px-3 py-1 text-xs ${
                colour === null
                  ? 'border-[var(--brand-ink)] bg-[var(--brand-ink)] text-[var(--brand-paper)]'
                  : 'border-[var(--brand-border)]'
              }`}
            >
              All
            </button>
            {colourOptions.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColour(c)}
                aria-pressed={colour === c}
                className={`rounded-full border px-3 py-1 text-xs ${
                  colour === c
                    ? 'border-[var(--brand-ink)] bg-[var(--brand-ink)] text-[var(--brand-paper)]'
                    : 'border-[var(--brand-border)]'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="min-w-[200px] flex-1">
          <legend className="text-sm font-medium">
            Max price: £{maxPrice.toFixed(2)}
          </legend>
          <input
            type="range"
            min={priceMin}
            max={priceMax}
            step={1}
            value={maxPrice}
            onChange={(e) => setMaxPrice(Number(e.target.value))}
            className="mt-3 w-full"
            aria-label="Maximum price"
          />
        </fieldset>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-[var(--brand-muted)]">
          No products match those filters. Reset the colour or price range to see more.
        </p>
      ) : (
        <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map(({ group }) => (
            <li key={group.id}>
              <CatalogueCard group={group} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CatalogueCard({ group }: { group: GroupListItem }) {
  const href = group.slug ? `/shop/${group.slug}` : '/shop';
  const priceFrom = group.priceRange
    ? group.priceRange.min === group.priceRange.max
      ? `£${group.priceRange.min}`
      : `£${group.priceRange.min} – £${group.priceRange.max}`
    : null;

  return (
    <Link
      href={href}
      className="group block overflow-hidden rounded-[var(--radius)] border border-[var(--brand-border)] transition-colors hover:border-[var(--brand-ink)]"
    >
      <div className="aspect-[4/5] overflow-hidden bg-[var(--brand-border)]">
        {group.heroImageUrl ? (
          <Image
            src={group.heroImageUrl}
            alt={group.name}
            width={800}
            height={1000}
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[var(--brand-muted)]">
            No image
          </div>
        )}
      </div>
      <div className="space-y-1 p-4">
        <h3 className="font-medium">{group.name}</h3>
        {group.shortDescription && (
          <p className="line-clamp-2 text-sm text-[var(--brand-muted)]">{group.shortDescription}</p>
        )}
        <div className="flex items-baseline justify-between pt-1">
          {priceFrom && <p className="text-sm font-medium">From {priceFrom}</p>}
          {group.totalAvailableQty === 0 && (
            <span className="text-xs text-[var(--brand-muted)]">Out of stock</span>
          )}
        </div>
      </div>
    </Link>
  );
}
