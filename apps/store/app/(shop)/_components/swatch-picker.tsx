'use client';

/**
 * Variant swatch picker for group pages.
 *
 * Updates the URL query (?colour=…) without a full nav so customers can
 * deep-link to a specific colour and the canonical group URL doesn't
 * fragment. The selected variant's images and stock counter update live.
 *
 * Visual treatment matches the industrial brand: square corners, hairline
 * borders, all-caps labels with wide tracking, steel-blue accent on the
 * price and selected swatch ring.
 */
import * as React from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import type { FullVariant } from '@/lib/api-types';
import { resolveInitialVariant } from '@/lib/variants';
import { DISPATCH_COPY, effectiveStockState, isSellable } from '@/lib/dispatch-copy';
import { AddToCartButton } from '@/components/add-to-cart-button';

export interface SwatchPickerProps {
  groupName: string;
  variants: FullVariant[];
}

export function SwatchPicker({ groupName, variants }: SwatchPickerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queriedColour = searchParams.get('colour');

  const initial = resolveInitialVariant(variants, queriedColour);
  const [selectedId, setSelectedId] = React.useState<string | undefined>(initial?.id);

  // Sync state when the URL query changes (back/forward navigation).
  React.useEffect(() => {
    const v = variants.find(
      (v) => v.colour && queriedColour && v.colour.toLowerCase() === queriedColour.toLowerCase(),
    );
    if (v && v.id !== selectedId) setSelectedId(v.id);
  }, [queriedColour, variants, selectedId]);

  const selected = variants.find((v) => v.id === selectedId) ?? variants[0];
  if (!selected) return null;

  const onPick = (variant: FullVariant) => {
    setSelectedId(variant.id);
    if (variant.colour) {
      const next = new URLSearchParams(searchParams.toString());
      next.set('colour', variant.colour.toLowerCase());
      router.replace(`?${next.toString()}`, { scroll: false });
    }
  };

  const selectedState = effectiveStockState(selected);
  const sellable = isSellable(selectedState);
  const inStock = sellable; // back-compat for the AddToCartButton prop
  // Only show per-swatch prices when colours actually differ in price —
  // repeating the same figure on every chip is noise. On this catalogue
  // they often DO differ (Green £7.25 vs Grey £9.25 on the same range),
  // which the customer previously discovered only after clicking.
  const pricesVary = new Set(variants.map((v) => v.priceGbp ?? '')).size > 1;
  const lowStock =
    selectedState === 'IN_STOCK' && selected.availableQty > 0 && selected.availableQty <= 5;

  return (
    <div className="mt-6">
      <div className="grid gap-10 md:grid-cols-2 md:gap-12">
        {/* Imagery column */}
        <div className="space-y-3">
          <div className="aspect-square overflow-hidden border border-[var(--brand-border)] bg-[var(--brand-bone)]">
            {selected.heroImageUrl ? (
              <Image
                key={selected.id}
                src={selected.heroImageUrl}
                alt={`${groupName} in ${selected.colour ?? 'unspecified colour'}`}
                width={1200}
                height={1200}
                priority
                sizes="(max-width: 768px) 100vw, 50vw"
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-xs uppercase tracking-wider text-[var(--brand-muted)]">
                No image
              </div>
            )}
          </div>
          {selected.galleryImageUrls && selected.galleryImageUrls.length > 0 && (
            <ul className="grid grid-cols-3 gap-2">
              {selected.galleryImageUrls.map((url, idx) => (
                <li
                  key={`${selected.id}-${idx}`}
                  className="aspect-square overflow-hidden border border-[var(--brand-border)] bg-[var(--brand-bone)]"
                >
                  <Image
                    src={url}
                    alt={`${groupName} in ${selected.colour ?? 'unspecified colour'} — gallery ${idx + 1}`}
                    width={400}
                    height={400}
                    sizes="(max-width: 768px) 33vw, 16vw"
                    className="h-full w-full object-cover"
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Info column */}
        <div className="flex flex-col gap-6">
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
              Landau · 1.75mm · 1kg
            </p>
            <h1
              className="text-3xl font-bold tracking-tight md:text-4xl"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {groupName}
              {selected.colour ? (
                <>
                  {' — '}
                  <span className="text-[var(--brand-accent)]">{selected.colour}</span>
                </>
              ) : null}
            </h1>
            {selected.shortDescription && (
              <p className="text-base leading-relaxed text-[var(--brand-muted)]">
                {selected.shortDescription}
              </p>
            )}
          </div>

          <div className="flex items-baseline gap-4 border-y border-[var(--brand-border)] py-5">
            <p className="text-3xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>
              {selected.priceGbp ? `£${selected.priceGbp}` : 'Price on request'}
            </p>
            <p className="text-xs uppercase tracking-wider text-[var(--brand-muted)]">
              per spool · inc. VAT
            </p>
          </div>

          <fieldset>
            <legend className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--brand-ink)]">
              Colour{' '}
              <span className="font-normal text-[var(--brand-muted)]">
                · {variants.length} {variants.length === 1 ? 'option' : 'options'}
              </span>
            </legend>
            <div className="mt-3 flex flex-wrap gap-2">
              {variants.map((v) => {
                const isSelected = v.id === selectedId;
                const state = effectiveStockState(v);
                const sellable = isSellable(state);
                const colourLabel = v.colour ?? 'Default';
                const stockLabel = DISPATCH_COPY[state].badgeLabel;
                // Two greens, no amber: IN_STOCK and AVAILABLE_FROM_SUPPLIER
                // both render the green token. Only OUT_OF_STOCK uses red.
                const flagColour = sellable
                  ? 'var(--brand-stock-in)'
                  : 'var(--brand-stock-out)';
                const flagDataTest = sellable ? 'stock-flag-in' : 'stock-flag-out';
                // UX 03: an unavailable colour used to carry exactly the
                // same visual weight as a buyable one, so on a range
                // where four of five are out of stock the customer's eye
                // had no way to find the one they could actually buy.
                // Dimmed, desaturated, and struck through the swatch dot.
                const unavailableClass = sellable ? '' : ' opacity-55 saturate-50';
                // Show the price on the swatch when colours differ in
                // price — otherwise the customer discovers a £2 delta
                // only after clicking.
                const swatchPrice =
                  pricesVary && v.priceGbp ? `£${v.priceGbp}` : null;
                return (
                  <button
                    key={v.id}
                    type="button"
                    data-test="swatch"
                    onClick={() => onPick(v)}
                    aria-pressed={isSelected}
                    aria-label={`${colourLabel}. ${stockLabel}.${
                      swatchPrice ? ` ${swatchPrice}.` : ''
                    }`}
                    title={`${colourLabel} — ${stockLabel}`}
                    className={
                      // min-h-11 = the 44px touch floor; the swatches
                      // were 30px tall on a handset.
                      (isSelected
                        ? 'flex min-h-11 items-center gap-2 border-2 border-[var(--brand-accent)] bg-[var(--brand-accent-ice)] px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors'
                        : 'flex min-h-11 items-center gap-2 border border-[var(--brand-border)] bg-[var(--brand-paper)] px-3 py-1.5 text-xs font-medium uppercase tracking-wider transition-colors hover:border-[var(--brand-ink)]') +
                      unavailableClass
                    }
                  >
                    {v.colourHex && (
                      <span
                        aria-hidden="true"
                        className="relative h-3.5 w-3.5 border border-[var(--brand-border)]"
                        style={{ backgroundColor: v.colourHex }}
                      >
                        {!sellable && (
                          <span
                            className="absolute inset-0 block"
                            style={{
                              // Diagonal rule: reads as "unavailable"
                              // without relying on colour alone, which
                              // matters for colour-blind customers.
                              background:
                                'linear-gradient(to top right, transparent 45%, var(--brand-stock-out) 45%, var(--brand-stock-out) 55%, transparent 55%)',
                            }}
                          />
                        )}
                      </span>
                    )}
                    <span>{colourLabel}</span>
                    {swatchPrice && (
                      <span className="font-mono text-[10px] font-normal normal-case tracking-normal text-[var(--brand-muted)]">
                        {swatchPrice}
                      </span>
                    )}
                    <span
                      aria-hidden="true"
                      data-test={flagDataTest}
                      data-stock-state={state}
                      // Raised from 9px: this is the single most
                      // decision-relevant word on the control and it was
                      // set smaller than everything around it.
                      className="border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em]"
                      style={{ color: flagColour, borderColor: flagColour }}
                    >
                      {stockLabel}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <p
            className={`text-sm font-medium ${
              !sellable
                ? 'text-[var(--brand-muted)]'
                : lowStock
                  ? 'text-[var(--brand-accent)]'
                  : 'text-[var(--brand-ink)]'
            }`}
            aria-live="polite"
            data-stock-state={selectedState}
          >
            {selectedState === 'IN_STOCK'
              ? lowStock
                ? `Only ${selected.availableQty} left in ${selected.colour ?? 'this colour'}.`
                : DISPATCH_COPY.IN_STOCK.primary
              : DISPATCH_COPY[selectedState].primary}
          </p>

          {/* data-test hook: the sticky mobile bar observes this element
              and only shows itself once this CTA leaves the viewport. */}
          <div data-test="primary-cta">
            <AddToCartButton
              productId={selected.id}
              inStock={inStock}
              showQuantity
              bulkHint="10+ spools of the same colour: discount applied at checkout."
            />
          </div>
        </div>
      </div>

      {/*
        UX 02: on a 15-colour range the buy button sat ~1,600px down on
        mobile — nearly two full screens of swatches before the customer
        could act. This bar carries the selected colour, its price and
        the action, and only appears once the main CTA has scrolled out
        of view, so it never double-renders next to itself.
        Hidden from md up, where the CTA is already in the first screen.
      */}
      {sellable && (
        <StickyBuyBar
          groupName={groupName}
          colour={selected.colour}
          priceGbp={selected.priceGbp}
          productId={selected.id}
        />
      )}
    </div>
  );
}

/**
 * Mobile-only sticky purchase bar.
 *
 * Visibility is driven by an IntersectionObserver on the main CTA rather
 * than a scroll offset — the page height varies enormously with the
 * number of colours, so any fixed threshold would be wrong on most
 * products.
 */
function StickyBuyBar({
  groupName,
  colour,
  priceGbp,
  productId,
}: {
  groupName: string;
  colour: string | null;
  priceGbp: string | null;
  productId: string;
}) {
  const [showBar, setShowBar] = React.useState(false);

  React.useEffect(() => {
    // The main CTA is the last AddToCartButton in the info column.
    const target = document.querySelector('[data-test="primary-cta"]');
    if (!target || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => setShowBar(!entry?.isIntersecting),
      { rootMargin: '0px 0px -80px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  if (!showBar) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--brand-border)] bg-[var(--brand-paper)] p-3 shadow-[0_-1px_0_var(--brand-border)] md:hidden">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold">
            {groupName}
            {colour ? ` — ${colour}` : ''}
          </p>
          {priceGbp && (
            <p className="text-sm font-bold text-[var(--brand-accent)]">£{priceGbp}</p>
          )}
        </div>
        <div className="w-40 shrink-0">
          <AddToCartButton productId={productId} inStock label="Add" />
        </div>
      </div>
    </div>
  );
}
