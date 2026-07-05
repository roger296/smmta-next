/**
 * Shop listing (SPEC F1–F3). Grid of product groups from the storefront read
 * surface. Each card links to the group's first variant PDP. £-only pricing.
 */
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { listGroups } from '@/lib/smmta';

export const metadata: Metadata = {
  title: 'Shop',
  description: 'Premium 3D printer filament — PLA, PETG, ABS, ASA, TPU. Pre-order deals on inbound stock.',
};

export const revalidate = 60;

function priceLabel(min: string | null | undefined, max: string | null | undefined): string | null {
  if (!min) return null;
  const fmt = (v: string) => `£${Number(v).toFixed(2)}`;
  return max && max !== min ? `${fmt(min)} – ${fmt(max)}` : `From ${fmt(min)}`;
}

export default async function ShopPage() {
  const groups = await listGroups();

  return (
    <div>
      <h1 className="font-[var(--font-display)] text-3xl font-bold tracking-tight">Filament</h1>
      <p className="mt-2 text-[var(--brand-muted)]">1.75mm · 1kg · vacuum-sealed. Pre-order inbound stock and save.</p>

      {groups.length === 0 ? (
        <p className="mt-10 text-[var(--brand-muted)]">Nothing here yet — check back soon.</p>
      ) : (
        <ul className="mt-8 grid grid-cols-1 gap-px bg-[var(--brand-border)] sm:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => {
            const href = `/shop/${encodeURIComponent(g.variants[0]?.slug ?? g.slug ?? '')}`;
            const price = priceLabel(g.priceRange?.min, g.priceRange?.max);
            return (
              <li key={g.id} className="bg-[var(--brand-bone)]">
                <Link href={href} className="group block">
                  <div className="relative aspect-square overflow-hidden bg-[var(--brand-paper)]">
                    {g.heroImageUrl ? (
                      <Image
                        src={g.heroImageUrl}
                        alt={g.name}
                        fill
                        sizes="(max-width: 640px) 100vw, 33vw"
                        className="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-[var(--brand-muted)]">No image</div>
                    )}
                  </div>
                  <div className="p-4">
                    <h2 className="text-sm font-semibold">{g.name}</h2>
                    {g.shortDescription && (
                      <p className="mt-1 line-clamp-2 text-xs text-[var(--brand-muted)]">{g.shortDescription}</p>
                    )}
                    {price && <p className="mt-2 text-sm font-medium">{price}</p>}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
