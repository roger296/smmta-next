'use client';

/**
 * Variant swatch picker for group pages.
 *
 * Updates the URL query (?colour=…) without a full nav so customers can
 * deep-link to a specific colour and the canonical group URL doesn't
 * fragment. The selected variant's images and stock counter update live.
 */
import * as React from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import type { FullVariant } from '@/lib/api-types';

export interface SwatchPickerProps {
  groupName: string;
  variants: FullVariant[];
}

export function SwatchPicker({ groupName, variants }: SwatchPickerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queriedColour = searchParams.get('colour');

  const initial =
    variants.find((v) => v.colour && queriedColour && v.colour.toLowerCase() === queriedColour.toLowerCase()) ??
    variants[0];
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

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-3">
          <div className="aspect-square overflow-hidden rounded-[var(--radius)] bg-[var(--brand-border)]">
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
              <div className="flex h-full items-center justify-center text-sm text-[var(--brand-muted)]">
                No image
              </div>
            )}
          </div>
          {selected.galleryImageUrls && selected.galleryImageUrls.length > 0 && (
            <ul className="grid grid-cols-3 gap-2">
              {selected.galleryImageUrls.map((url, idx) => (
                <li key={`${selected.id}-${idx}`} className="aspect-square overflow-hidden rounded-[var(--radius)] bg-[var(--brand-border)]">
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

        <div className="space-y-4">
          <div>
            <h2
              className="text-2xl font-semibold tracking-tight"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {groupName}
              {selected.colour ? ` — ${selected.colour}` : ''}
            </h2>
            {selected.shortDescription && (
              <p className="mt-2 text-base text-[var(--brand-muted)]">
                {selected.shortDescription}
              </p>
            )}
          </div>

          <p className="text-2xl font-medium">
            {selected.priceGbp ? `£${selected.priceGbp}` : 'Price on request'}
          </p>

          <fieldset>
            <legend className="text-sm font-medium">Colour</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {variants.map((v) => {
                const isSelected = v.id === selectedId;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => onPick(v)}
                    aria-pressed={isSelected}
                    className={`flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${
                      isSelected
                        ? 'border-[var(--brand-ink)] bg-[var(--brand-ink)] text-[var(--brand-paper)]'
                        : 'border-[var(--brand-border)]'
                    }`}
                  >
                    {v.colourHex && (
                      <span
                        aria-hidden="true"
                        className="h-4 w-4 rounded-full border border-[var(--brand-border)]"
                        style={{ backgroundColor: v.colourHex }}
                      />
                    )}
                    {v.colour ?? 'Default'}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <p className="text-sm text-[var(--brand-muted)]" aria-live="polite">
            {selected.availableQty > 0
              ? selected.availableQty <= 5
                ? `Only ${selected.availableQty} left in this colour.`
                : 'In stock.'
              : 'Out of stock — check back soon.'}
          </p>

          <button
            type="button"
            disabled={selected.availableQty === 0}
            className="w-full rounded-[var(--radius)] bg-[var(--brand-ink)] px-6 py-3 text-base font-medium text-[var(--brand-paper)] transition-colors hover:bg-[var(--brand-accent)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {selected.availableQty > 0 ? 'Add to cart' : 'Notify me'}
          </button>
          <p className="text-xs text-[var(--brand-muted)]">
            Cart and checkout land in Prompt 9. The button above is wired up to the basket once
            that prompt ships.
          </p>
        </div>
      </div>
    </div>
  );
}
