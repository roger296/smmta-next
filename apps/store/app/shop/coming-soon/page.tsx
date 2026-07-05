/**
 * Coming-soon catalogue (SPEC F8, §5.2). Prospective products with a group-buy
 * progress bar (interest count vs threshold) and a register-interest form —
 * a lighter commitment than a paid pre-order, and the demand signal that
 * de-risks the next purchase order.
 */
import type { Metadata } from 'next';
import { getComingSoon } from '@/lib/smmta';
import { RegisterInterestForm } from '@/components/register-interest-form';

export const metadata: Metadata = {
  title: 'Coming soon',
  description:
    'Filament we are considering ranging — register interest and help us decide what to bring in next.',
};

export const revalidate = 60;

export default async function ComingSoonPage() {
  const items = await getComingSoon();

  return (
    <div>
      <h1 className="font-[var(--font-display)] text-3xl font-bold tracking-tight">Coming soon</h1>
      <p className="mt-2 text-[var(--brand-muted)]">
        Filament we&apos;re considering. Register interest — when enough people want it, we bring it in.
      </p>

      {items.length === 0 ? (
        <p className="mt-10 text-[var(--brand-muted)]">Nothing on the horizon right now — check back soon.</p>
      ) : (
        <ul className="mt-8 grid grid-cols-1 gap-px bg-[var(--brand-border)] md:grid-cols-2">
          {items.map((item) => {
            const pct = item.interestThreshold
              ? Math.min(100, Math.round((item.interestCount / item.interestThreshold) * 100))
              : null;
            return (
              <li key={item.id} className="bg-[var(--brand-bone)] p-5">
                <h2 className="text-base font-semibold">{item.name}</h2>
                {item.creatorPartner && (
                  <p className="mt-0.5 text-xs text-[var(--brand-muted)]">with {item.creatorPartner}</p>
                )}
                {item.description && <p className="mt-2 text-sm text-[var(--brand-muted)]">{item.description}</p>}

                {item.interestThreshold != null && (
                  <div className="mt-4">
                    <div className="flex justify-between text-xs text-[var(--brand-muted)]">
                      <span>
                        {item.interestCount} of {item.interestThreshold} interested
                      </span>
                      <span>{pct}%</span>
                    </div>
                    <div className="mt-1 h-2 w-full bg-[var(--brand-paper)]">
                      <div className="h-2" style={{ width: `${pct}%`, background: 'var(--brand-accent)' }} />
                    </div>
                  </div>
                )}

                <div className="mt-4">
                  <RegisterInterestForm prospectiveId={item.id} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
