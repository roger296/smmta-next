import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, Warehouse } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import { cn } from '@/lib/utils';
import { useSiteContext } from '@/features/sites/site-context';
import { useStockLevels, useStockValuation } from '@/features/stock/use-stock-levels';

export const Route = createFileRoute('/_authed/stock/by-site')({
  component: StockBySitePage,
});

function isLow(onHand: string, reorderPoint: string | null): boolean {
  return reorderPoint !== null && Number(onHand) <= Number(reorderPoint);
}

function StockBySitePage() {
  const { selectedSite, selectedSiteId, sites, isLoading: sitesLoading } = useSiteContext();
  const { data: levels, isLoading } = useStockLevels(selectedSiteId);
  const { data: valuation } = useStockValuation(selectedSiteId);

  const currency = selectedSite?.currencyCode ?? 'GBP';
  const money = (v: number) =>
    new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(v);

  if (!sitesLoading && sites.length === 0) {
    return (
      <EmptyState
        icon={Warehouse}
        title="No sites yet"
        description="Add a site first, then stock levels will show here per site."
      />
    );
  }

  const lowCount = levels?.filter((r) => isLow(r.onHand, r.reorderPoint)).length ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Stock — {selectedSite?.name ?? '…'}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          On-hand and valuation for the selected site. Use the site switcher in the header to
          change site.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
              Total stock value
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{money(valuation?.total ?? 0)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
              Distinct lines
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{levels?.length ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
              Low stock
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p
              className={cn(
                'text-2xl font-semibold',
                lowCount > 0 && 'text-[var(--color-destructive)]',
              )}
            >
              {lowCount}
            </p>
          </CardContent>
        </Card>
      </div>

      {isLoading && (
        <Card>
          <CardContent className="space-y-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      )}

      {!isLoading && levels && levels.length === 0 && (
        <EmptyState
          icon={Warehouse}
          title="No stock at this site yet"
          description="Stock appears once goods are received, adjusted or transferred in."
        />
      )}

      {!isLoading && levels && levels.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted-foreground)]">
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">Kind</th>
                  <th className="px-4 py-3 font-medium text-right">On hand</th>
                  <th className="px-4 py-3 font-medium text-right">Reorder point</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {levels.map((row) => {
                  const low = isLow(row.onHand, row.reorderPoint);
                  return (
                    <tr
                      key={`${row.productId}-${row.siteId}`}
                      className={cn(
                        'border-b border-[var(--color-border)] last:border-0',
                        low && 'bg-[var(--color-destructive)]/5',
                      )}
                    >
                      <td className="px-4 py-3 font-medium">{row.productName}</td>
                      <td className="px-4 py-3">{row.itemKind}</td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {Number(row.onHand)} {row.stockUom}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {row.reorderPoint !== null ? Number(row.reorderPoint) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {low ? (
                          <Badge variant="destructive" className="gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            Low
                          </Badge>
                        ) : (
                          <Badge variant="secondary">OK</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
