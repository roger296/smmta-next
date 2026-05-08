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
      className="mt-20 space-y-8"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
            More from the range
          </p>
          <h2
            id="you-may-also-like"
            className="text-2xl font-bold tracking-tight md:text-3xl"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            You may also like.
          </h2>
        </div>
        <Link
          href="/shop"
          className="text-sm font-semibold uppercase tracking-wider text-[var(--brand-accent)] hover:underline"
        >
          View all ranges →
        </Link>
      </div>

      <ul className="grid gap-px bg-[var(--brand-border)] sm:grid-cols-2 lg:grid-cols-3">
        {picks.map((g) => {
          const priceFrom = priceFromString(g);
          return (
            <li key={g.id} className="bg-[var(--brand-paper)]">
              <Link
                href={`/shop/${g.slug}`}
                className="group block h-full transition-colors hover:bg-[var(--brand-bone)]"
              >
                <div className="aspect-square overflow-hidden bg-[var(--brand-bone)]">
                  {g.heroImageUrl ? (
                    <Image
                      src={g.heroImageUrl}
                      alt={g.name}
                      width={600}
                      height={600}
                      sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                      className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs uppercase tracking-wider text-[var(--brand-muted)]">
                      No image
                    </div>
                  )}
                </div>
                <div className="space-y-2 p-5">
                  <h3 className="text-base font-semibold leading-snug">{g.name}</h3>
                  {g.shortDescription ? (
                    <p className="line-clamp-2 text-sm text-[var(--brand-muted)]">
                      {g.shortDescription}
                    </p>
                  ) : null}
                  {priceFrom ? (
                    <p className="pt-1 text-sm font-semibold text-[var(--brand-accent)]">
                      From {priceFrom}
                    </p>
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
