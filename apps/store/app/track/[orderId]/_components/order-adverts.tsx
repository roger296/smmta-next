/**
 * Suggestions on the track page: the same ranges picked for the customer as
 * in their shipped email, then our two stores in their own colours.
 */
import Image from 'next/image';
import Link from 'next/link';
import { accentFor, SPOOL_COLOURS, storeAdverts, type Recommendation } from '@/lib/recommendations';

interface Props {
  recommendations: Recommendation[];
  storeBaseUrl: string;
}

export function OrderAdverts({ recommendations, storeBaseUrl }: Props) {
  return (
    <section aria-label="Suggestions from our stores" className="space-y-10">
      <div className="flex h-1.5" aria-hidden="true">
        {SPOOL_COLOURS.map((c) => (
          <span key={c} className="flex-1" style={{ background: c }} />
        ))}
      </div>

      {recommendations.length > 0 ? (
        <div className="space-y-5">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent)]">
              Picked for your next print
            </p>
            <h2 className="text-2xl font-bold tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
              You might like these next
            </h2>
          </div>
          <ul className="grid gap-4 sm:grid-cols-2">
            {recommendations.map((r) => {
              const accent = accentFor(r.material);
              return (
                <li key={r.groupId} className="border border-[var(--brand-border)] bg-white">
                  <Link href={r.path} className="group flex h-full flex-col">
                    <span className="block h-1.5" style={{ background: accent.bar }} aria-hidden="true" />
                    {r.imageUrl ? (
                      <div className="aspect-[4/3] overflow-hidden bg-[var(--brand-bone)]">
                        <Image
                          src={r.imageUrl}
                          alt={r.name}
                          width={600}
                          height={450}
                          sizes="(max-width: 640px) 100vw, 50vw"
                          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                        />
                      </div>
                    ) : null}
                    <div className="flex flex-1 flex-col gap-2 p-5">
                      <p className="text-xs font-bold uppercase tracking-wider" style={{ color: accent.ink }}>
                        {r.eyebrow}
                      </p>
                      <h3 className="text-lg font-bold leading-snug">{r.name}</h3>
                      {r.blurb ? <p className="text-sm text-[var(--brand-muted)]">{r.blurb}</p> : null}
                      <div className="mt-auto flex items-center justify-between gap-3 pt-3">
                        {r.priceFrom ? <p className="text-sm font-semibold">From {r.priceFrom}</p> : <span />}
                        <span className="bg-[var(--brand-ink)] px-4 py-2 text-sm font-semibold text-white transition-colors group-hover:bg-[var(--brand-accent)]">
                          Shop now →
                        </span>
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="space-y-5">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: '#C23A61' }}>
            Shop our stores
          </p>
          <h2 className="text-2xl font-bold tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
            More from CleverDeals
          </h2>
        </div>
        <ul className="grid gap-4 sm:grid-cols-2">
          {storeAdverts(storeBaseUrl).map((s) => (
            <li key={s.name} style={{ background: s.colours.background, color: s.colours.text }}>
              {s.spoolStrip ? (
                <div className="flex h-1" aria-hidden="true">
                  {SPOOL_COLOURS.map((c) => (
                    <span key={c} className="flex-1" style={{ background: c }} />
                  ))}
                </div>
              ) : null}
              <a href={s.url} className="group flex h-full flex-col gap-2 p-6">
                <span className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: s.colours.muted }}>
                  {s.host}
                </span>
                <span
                  className="text-2xl font-bold"
                  style={{ fontFamily: s.serif ? "Georgia, 'Times New Roman', serif" : 'var(--font-display)' }}
                >
                  {s.name}
                </span>
                <span className="font-semibold">{s.strap}</span>
                <span className="text-sm" style={{ color: s.colours.muted }}>
                  {s.detail}
                </span>
                <span
                  className="mt-3 self-start px-4 py-2 text-sm font-semibold transition-opacity group-hover:opacity-90"
                  style={{ background: s.colours.button, color: s.colours.buttonText }}
                >
                  {s.cta} →
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
