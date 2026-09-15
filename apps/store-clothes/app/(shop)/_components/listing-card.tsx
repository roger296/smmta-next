/**
 * One card on a category or search page: a whole range, with its price, its
 * colours as swatches and its size span, linking to the range page where the
 * customer picks colour and size. A product with no range page gets the same
 * card linking to its own page.
 */
import Image from 'next/image';
import Link from 'next/link';
import type { CategoryListing } from '@/lib/smmta';
import { colourSummary, listingHref, priceLabel, sizeSummary, swatchColour } from '@/lib/listing';

/** Swatches shown before "+N". */
const MAX_SWATCHES = 12;

export function ListingCard({
  listing,
  chosenColours,
  chosenSizes,
  priority = false,
}: {
  listing: CategoryListing;
  /** The colour and size filters in force, so the range page opens on them. */
  chosenColours?: string[] | null;
  chosenSizes?: string[] | null;
  priority?: boolean;
}) {
  const href = listingHref(listing, { colour: chosenColours, size: chosenSizes });
  const price = priceLabel(listing);
  const colours = colourSummary(listing.colours);
  const sizes = sizeSummary(listing.sizes);
  const details = [colours, sizes].filter(Boolean).join(' · ');
  const swatches = listing.colours.slice(0, MAX_SWATCHES);
  const more = listing.colours.length - swatches.length;

  return (
    <Link href={href} className="group flex h-full flex-col transition-colors hover:bg-[var(--brand-bone)]">
      <div className="relative aspect-square overflow-hidden bg-[var(--brand-bone)]">
        {listing.heroImageUrl ? (
          <Image
            src={listing.heroImageUrl}
            alt={listing.name}
            width={400}
            height={400}
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            priority={priority}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs uppercase tracking-wider text-[var(--brand-muted)]">
            No image
          </div>
        )}
        {listing.stockState === 'OUT_OF_STOCK' && (
          <span className="absolute right-3 top-3 border border-[var(--brand-ink)] bg-[var(--brand-paper)] px-2 py-1 text-[10px] font-semibold uppercase tracking-wider">
            Out of stock
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug">{listing.name}</h3>
        {price && <p className="text-sm font-semibold text-[var(--brand-accent)]">{price}</p>}
        {listing.kind === 'range' && swatches.length > 1 && (
          <ul className="flex flex-wrap items-center gap-1.5" aria-hidden="true" data-test="card-swatches">
            {swatches.map((c) => {
              const fill = swatchColour(c.hex);
              return (
                <li
                  key={c.name}
                  title={c.name}
                  className="h-4 w-4 rounded-full border border-[var(--brand-border)]"
                  style={fill ? { backgroundColor: fill } : undefined}
                />
              );
            })}
            {more > 0 && <li className="text-xs text-[var(--brand-muted)]">+{more}</li>}
          </ul>
        )}
        {listing.kind === 'range' && details && (
          <p className="mt-auto text-xs text-[var(--brand-muted)]">{details}</p>
        )}
      </div>
    </Link>
  );
}
