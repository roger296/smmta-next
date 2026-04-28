/**
 * "You may also like" — a small grid of three other published groups,
 * deterministically chosen so the same group page renders the same set
 * across requests (good for caching, good for crawlers).
 *
 * Server component. The list is filtered to exclude the current group,
 * then sorted by sortOrder, then we pick three using a stable seed from
 * the current group's slug — no Math.random per request.
 */
import Image from 'next/image';
import Link from 'next/link';
import type { GroupListItem } from '@/lib/api-types';
import { priceFromString } from '@/lib/seo/structured-data';

interface Props {
  /** Slug of the current group — excluded from the result + used as the
   *  rotation seed so the same page shows the same suggestions. */
  currentSlug: string;
  groups: GroupListItem[];
}

/** Tiny string-hash → index. Deterministic per slug, no PRNG. */
function pickStartIndex(seed: string, length: number): number {
  if (length === 0) return 0;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % length;
}

export function YouMayAlsoLike({ currentSlug, groups }: Props) {
  const eligible = groups.filter(
    (g): g is GroupListItem & { slug: string } =>
      Boolean(g.slug) && g.slug !== currentSlug,
  );
  if (eligible.length === 0) return null;

  // Take three starting from a slug-derived offset, wrapping around.
  const start = pickStartIndex(currentSlug, eligible.length);
  const picks: typeof eligible = [];
  for (let i = 0; i < Math.min(3, eligible.length); i++) {
    picks.push(eligible[(start + i) % eligible.length]!);
  }

  return (
    <section
      aria-labelledby="you-may-also-like"
      className="mt-16 space-y-6"
    >
      <h2
        id="you-may-also-like"
        className="text-2xl font-semibold tracking-tight"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        You may also like
      </h2>
      <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {picks.map((g) => {
          const priceFrom = priceFromString(g);
          return (
            <li key={g.id}>
              <Link
                href={`/shop/${g.slug}`}
                className="group block overflow-hidden rounded-[var(--radius)] border border-[var(--brand-border)] transition-colors hover:border-[var(--brand-ink)]"
              >
                <div className="aspect-[4/5] overflow-hidden bg-[var(--brand-border)]">
                  {g.heroImageUrl ? (
                    <Image
                      src={g.heroImageUrl}
                      alt={g.name}
                      width={600}
                      height={750}
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
                  <h3 className="font-medium">{g.name}</h3>
                  {g.shortDescription ? (
                    <p className="line-clamp-2 text-sm text-[var(--brand-muted)]">
                      {g.shortDescription}
                    </p>
                  ) : null}
                  {priceFrom ? (
                    <p className="text-sm font-medium">From {priceFrom}</p>
                  ) : null}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
