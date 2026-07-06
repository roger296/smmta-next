/**
 * Pre-order pools block for the product page (SPEC F1, §15.1a, §16.2). Renders
 * the warehouse buy-box state plus each inbound-shipment pre-order option with
 * its ETA and the £ saving (never a percentage). Drop `<PreorderPools sku=… />`
 * into the PDP once the shop pages exist; it fetches server-side via getSkuPools.
 *
 * This is a server component (async) — safe to render in a Next PDP.
 */
import Link from 'next/link';
import { getSkuPools, SmmtaApiError, type SkuPool } from '@/lib/smmta';

const gbp = (pence: number) => `£${(pence / 100).toFixed(2)}`;

function etaLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}

const modeWord: Record<string, string> = {
  sea: 'by sea',
  air: 'by air',
  road: 'by road',
  rail: 'by rail',
  courier: 'by courier',
};

export async function PreorderPools({ sku }: { sku: string }) {
  let pools;
  try {
    pools = await getSkuPools(sku);
  } catch (err) {
    if (err instanceof SmmtaApiError) return null; // fail quiet on the PDP
    throw err;
  }

  const inStock = pools.warehouse.band !== 'out_of_stock';
  const hasPreorder = pools.inbound.length > 0;
  if (!inStock && !hasPreorder) return null;

  return (
    <section
      aria-label="Availability and pre-order"
      className="mt-6 border border-[var(--brand-border)]"
    >
      <div className="border-b border-[var(--brand-border)] px-4 py-3">
        {inStock ? (
          <p className="text-sm">
            <strong>In stock</strong>
            {pools.warehouse.band === 'low_stock' ? ' — low stock, order soon' : ''}
            {pools.warehouse.pricePence != null ? ` · ${gbp(pools.warehouse.pricePence)}` : ''}
          </p>
        ) : (
          <p className="text-sm text-[var(--brand-muted)]">Out of stock in the warehouse — pre-order below.</p>
        )}
      </div>

      {hasPreorder && (
        <ul>
          {pools.inbound.map((pool: SkuPool) => (
            <li key={pool.shipmentRef} className="border-b border-[var(--brand-border)] px-4 py-3 last:border-b-0">
              <div className="flex items-baseline justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">
                    Pre-order {modeWord[pool.mode] ?? ''} — due around {etaLabel(pool.eta)}
                  </p>
                  <p className="text-xs text-[var(--brand-muted)]">
                    {pool.presaleAvailable} available at this price · estimate, not a fixed date
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold">{gbp(pool.unitPricePence)}</p>
                  {pool.savingsVsBasePence > 0 && (
                    <p className="text-xs" style={{ color: 'var(--brand-accent)' }}>
                      Save {gbp(pool.savingsVsBasePence)}
                    </p>
                  )}
                </div>
              </div>
              <Link
                href={`/shop/preorder?slug=${encodeURIComponent(sku)}&pool=${encodeURIComponent(pool.shipmentRef)}`}
                className="mt-3 inline-block bg-[var(--brand-accent)] px-3 py-1.5 text-xs font-semibold text-white"
              >
                Pre-order
              </Link>
            </li>
          ))}
        </ul>
      )}

      {hasPreorder && (
        <p className="px-4 py-3 text-xs text-[var(--brand-muted)]">
          Pre-orders are paid by bank transfer, which helps fund the shipment — that&apos;s why the saving is bigger
          the earlier you commit. Cancel any time before dispatch for a full refund.
        </p>
      )}
    </section>
  );
}
