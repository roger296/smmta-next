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

  const inStock = selected.availableQty > 0;
  const lowStock = inStock && selected.availableQty <= 5;

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
              per spool · ex VAT
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
                const variantInStock = v.availableQty > 0;
                const colourLabel = v.colour ?? 'Default';
                const stockLabel = variantInStock ? 'In stock' : 'Out of stock';
                return (
                  <button
                    key={v.id}
                    type="button"
                    data-test="swatch"
                    onClick={() => onPick(v)}
                    aria-pressed={isSelected}
                    aria-label={`${colourLabel}. ${stockLabel}.`}
                    title={`${colourLabel} — ${stockLabel}`}
                    className={
                      isSelected
                        ? 'flex items-center gap-2 border-2 border-[var(--brand-accent)] bg-[var(--brand-accent-ice)] px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors'
                        : 'flex items-center gap-2 border border-[var(--brand-border)] bg-[var(--brand-paper)] px-3 py-1.5 text-xs font-medium uppercase tracking-wider transition-colors hover:border-[var(--brand-ink)]'
                    }
                  >
                    {v.colourHex && (
                      <span
                        aria-hidden="true"
                        className="h-3.5 w-3.5 border border-[var(--brand-border)]"
                        style={{ backgroundColor: v.colourHex }}
                      />
                    )}
                    <span>{colourLabel}</span>
                    <span
                      aria-hidden="true"
                      data-test={variantInStock ? 'stock-flag-in' : 'stock-flag-out'}
                      className="border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em]"
                      style={{
                        color: variantInStock ? 'var(--brand-stock-in)' : 'var(--brand-stock-out)',
                        borderColor: variantInStock
                          ? 'var(--brand-stock-in)'
                          : 'var(--brand-stock-out)',
                      }}
                    >
                      {variantInStock ? 'In stock' : 'Out of stock'}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <p
            className={`text-sm font-medium ${
              !inStock
                ? 'text-[var(--brand-muted)]'
                : lowStock
                  ? 'text-[var(--brand-accent)]'
                  : 'text-[var(--brand-ink)]'
            }`}
            aria-live="polite"
          >
            {inStock
              ? lowStock
                ? `Only ${selected.availableQty} left in ${selected.colour ?? 'this colour'}.`
                : `In stock — ${selected.availableQty} available.`
              : 'Out of stock — check back soon.'}
          </p>

          <AddToCartButton
            productId={selected.id}
            inStock={inStock}
          />
        </div>
      </div>
    </div>
  );
}
