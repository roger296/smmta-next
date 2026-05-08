'use client';

/**
 * Multi-axis variant selector for the Clothes Shop PDP.
 *
 * Reads `attributeAxes` off the group and renders one selector per
 * axis (size as a row of pills, colour as swatches). State is local;
 * the URL stays at the canonical group slug — selection is `?size=`
 * + `?colour=` query-string only, so deep-links still work.
 *
 * The component name is intentionally `SwatchPicker` (matching the
 * Filament Store one) so the shop page can import the same name from
 * a parallel path. When the duplication starts hurting, extract a
 * shared component (Roger's "duplicate, don't share" call — spec §3.2).
 */
import * as React from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import type { FullVariant } from '@/lib/api-types';
import { DISPATCH_COPY, effectiveStockState, isSellable } from '@/lib/dispatch-copy';
import { listAxisValues, resolveVariant } from '@/lib/variant-selector';
import { AddToCartButton } from '@/components/add-to-cart-button';

export interface SwatchPickerProps {
  groupName: string;
  variants: FullVariant[];
  /** Which attribute keys this group's variants vary along. Falls back
   *  to `['colour']` for legacy groups. */
  attributeAxes?: string[];
}

export function SwatchPicker({ groupName, variants, attributeAxes }: SwatchPickerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const axes = attributeAxes && attributeAxes.length > 0 ? attributeAxes : ['colour'];

  const initial = React.useMemo<Record<string, string>>(() => {
    const fromQuery: Record<string, string> = {};
    for (const ax of axes) {
      const v = searchParams.get(ax);
      if (v) fromQuery[ax] = v;
    }
    if (Object.keys(fromQuery).length === axes.length) return fromQuery;
    const sellable = variants.find((v) =>
      isSellable(effectiveStockState(v)) && v.attributes,
    );
    const seed = sellable?.attributes ?? variants[0]?.attributes ?? {};
    const merged: Record<string, string> = { ...seed };
    for (const ax of axes) if (fromQuery[ax]) merged[ax] = fromQuery[ax];
    return merged;
  }, [axes, searchParams, variants]);

  const [selection, setSelection] = React.useState<Record<string, string>>(initial);

  React.useEffect(() => {
    const next = new URLSearchParams(searchParams.toString());
    for (const ax of axes) {
      if (selection[ax]) next.set(ax, selection[ax]!);
    }
    const qs = next.toString();
    router.replace(qs ? `?${qs}` : '?', { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  const selected = resolveVariant(variants, selection);
  const fallback = variants[0];
  const display = selected ?? fallback;
  if (!display) return null;

  const selectedState = effectiveStockState(display);
  const sellable = !!selected && isSellable(selectedState);
  const noMatch = !selected && Object.keys(selection).length > 0;

  return (
    <div className="mt-6">
      <div className="grid gap-10 md:grid-cols-2 md:gap-12">
        <div className="space-y-3">
          <div className="aspect-square overflow-hidden border border-[var(--brand-border)] bg-[var(--brand-bone)]">
            {display.heroImageUrl ? (
              <Image
                key={display.id}
                src={display.heroImageUrl}
                alt={`${groupName} — ${describeSelection(selection)}`}
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
        </div>

        <div className="flex flex-col gap-6">
          <div className="space-y-3">
            <h1
              className="text-3xl font-bold tracking-tight md:text-4xl"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {groupName}
            </h1>
            {display.shortDescription && (
              <p className="text-base leading-relaxed text-[var(--brand-muted)]">
                {display.shortDescription}
              </p>
            )}
          </div>

          <div className="flex items-baseline gap-4 border-y border-[var(--brand-border)] py-5">
            <p className="text-3xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>
              {display.priceGbp ? `£${display.priceGbp}` : 'Price on request'}
            </p>
            <p className="text-xs uppercase tracking-wider text-[var(--brand-muted)]">
              ex VAT
            </p>
          </div>

          {axes.map((axis) => {
            const values = listAxisValues(axis, variants);
            if (values.length === 0) return null;
            return (
              <fieldset key={axis}>
                <legend className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--brand-ink)]">
                  {humanAxisLabel(axis)}
                  <span className="ml-2 font-normal text-[var(--brand-muted)]">
                    · {values.length} {values.length === 1 ? 'option' : 'options'}
                  </span>
                </legend>
                <div className="mt-3 flex flex-wrap gap-2">
                  {values.map((opt) => {
                    const isSel = selection[axis] === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        data-test="swatch"
                        data-axis={axis}
                        onClick={() => setSelection((prev) => ({ ...prev, [axis]: opt.value }))}
                        aria-pressed={isSel}
                        aria-label={`${humanAxisLabel(axis)}: ${opt.value}${opt.hasStock ? '' : ' (out of stock)'}`}
                        title={opt.value}
                        className={
                          isSel
                            ? 'border-2 border-[var(--brand-accent)] bg-[var(--brand-accent-ice)] px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors'
                            : 'border border-[var(--brand-border)] bg-[var(--brand-bone)] px-3 py-1.5 text-xs font-medium uppercase tracking-wider transition-colors hover:border-[var(--brand-ink)]'
                        }
                      >
                        {opt.value}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}

          <p
            className={`text-sm font-medium ${
              !sellable
                ? 'text-[var(--brand-muted)]'
                : 'text-[var(--brand-ink)]'
            }`}
            aria-live="polite"
            data-stock-state={selected ? selectedState : 'NO_MATCH'}
          >
            {noMatch
              ? "Sorry, that combination isn't in stock."
              : DISPATCH_COPY[selectedState].primary}
          </p>

          <AddToCartButton productId={selected ? selected.id : ''} inStock={sellable} />
        </div>
      </div>
    </div>
  );
}

function humanAxisLabel(axis: string): string {
  switch (axis) {
    case 'size': return 'Size';
    case 'colour': return 'Colour';
    case 'fit': return 'Fit';
    default: return axis.charAt(0).toUpperCase() + axis.slice(1);
  }
}

function describeSelection(selection: Record<string, string>): string {
  const parts = Object.entries(selection).map(([k, v]) => `${humanAxisLabel(k)} ${v}`);
  return parts.length > 0 ? parts.join(', ') : 'default';
}
