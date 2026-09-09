/**
 * The price shown on a product page.
 *
 * Filament is priced by volume: one roll costs the ceiling price, ten or more
 * cost the floor, and the quantities between slide evenly across that range.
 * A single figure would therefore be wrong for most baskets, so the page shows
 * the band and says what moves it.
 *
 * `priceGbp` is the FLOOR (the 10+ rate) — it keeps that meaning everywhere in
 * the API. `maxPriceGbp` is the ceiling. When the ceiling is absent or not
 * above the floor the product does not slide and this renders exactly what it
 * always did: one price.
 */
import { VOLUME_PRICE_BEST_QTY, priceBandPence } from '@smmta/shared-types';

function toPence(major: string): number {
  return Math.round(Number(major) * 100);
}

function money(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

export interface PriceBandProps {
  /** Floor price (the 10+ rate), as returned by the API's priceGbp. */
  priceGbp: string | null;
  /** Ceiling price — what a single unit costs. */
  maxPriceGbp: string | null;
  className?: string;
}

export function PriceBand({ priceGbp, maxPriceGbp, className }: PriceBandProps) {
  if (!priceGbp) {
    return (
      <div className={className}>
        <p className="text-3xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>
          Price on request
        </p>
      </div>
    );
  }

  const floorPence = toPence(priceGbp);
  const ceilingPence = maxPriceGbp != null ? toPence(maxPriceGbp) : null;
  const band = priceBandPence(floorPence, ceilingPence);

  // Flat-priced product — unchanged from before volume pricing existed.
  if (!band.slides) {
    return (
      <div className={`flex items-baseline gap-4 ${className ?? ''}`}>
        <p className="text-3xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>
          {money(band.fromPence)}
        </p>
        <p className="text-xs uppercase tracking-wider text-[var(--brand-muted)]">
          per spool · inc. VAT
        </p>
      </div>
    );
  }

  return (
    <div className={className}>
      <p className="text-3xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>
        From {money(band.fromPence)} to {money(band.toPence)}
      </p>
      <p className="mt-1 text-sm text-[var(--brand-muted)]">
        depending on volume. But {VOLUME_PRICE_BEST_QTY} rolls or more to get the best price.
      </p>
      <p className="mt-2 text-xs uppercase tracking-wider text-[var(--brand-muted)]">
        per spool · inc. VAT
      </p>
    </div>
  );
}
