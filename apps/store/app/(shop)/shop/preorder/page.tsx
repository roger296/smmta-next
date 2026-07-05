/**
 * Pre-order checkout page (SPEC §16). Reached from the PDP pre-order pools.
 * Reads ?slug=&pool=, fetches the locked price + ETA server-side, and renders
 * the CCR-tick checkout form.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getSkuPools } from '@/lib/smmta';
import { PreorderCheckout } from '@/components/preorder-checkout';

export const metadata: Metadata = { title: 'Pre-order', robots: { index: false } };
export const dynamic = 'force-dynamic';

function etaLabel(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}

export default async function PreorderPage({
  searchParams,
}: {
  searchParams: Promise<{ slug?: string; pool?: string }>;
}) {
  const { slug, pool } = await searchParams;
  if (!slug || !pool) notFound();

  const pools = await getSkuPools(slug).catch(() => null);
  const match = pools?.inbound.find((p) => p.shipmentRef === pool);
  if (!pools || !match) notFound();

  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-4 font-[var(--font-display)] text-2xl font-bold tracking-tight">Pre-order</h1>
      <PreorderCheckout
        slug={slug}
        sku={pools.sku}
        poolRef={match.shipmentRef}
        etaLabel={etaLabel(match.eta)}
        unitPricePence={match.unitPricePence}
        savingsVsBasePence={match.savingsVsBasePence}
      />
    </div>
  );
}
