import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useSiteContext } from '@/features/sites/site-context';
import { useRoles } from '@/features/auth/use-roles';
import {
  SCOPE_LABEL,
  STATUS_LABEL,
  londonDaysAgo,
  type StockTakeFilters,
  type StockTakeRow,
  useCancelStockTake,
  useStockTakeDownloads,
  useStockTakeList,
  whenLabel,
} from '@/features/stock-takes/use-stock-takes';
import { Download } from 'lucide-react';

export const Route = createFileRoute('/_authed/stock-takes/')({
  component: StockTakesPage,
});

const STATUS_BADGE: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  OPEN: 'default',
  APPROVED: 'secondary',
  CANCELLED: 'outline',
};

/**
 * Stock-take results (Oct 2026): every venue's counts, any status, a date
 * range, each one viewable and downloadable — and the whole filtered set in
 * one spreadsheet. The counting itself stays on the iPad screen.
 */
export function StockTakesPage() {
  const { sites } = useSiteContext();
  const { can } = useRoles();
  const mayCancel = can(['site_manager']);
  const [filters, setFilters] = React.useState<StockTakeFilters>({
    from: londonDaysAgo(30),
    to: londonDaysAgo(0),
  });
  const [hideEmpty, setHideEmpty] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const list = useStockTakeList(filters);
  const downloads = useStockTakeDownloads();
  const cancel = useCancelStockTake();
  const siteName = React.useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);

  const all = list.data ?? [];
  // An empty sheet is noise in a results list — 37 of the first 49 were.
  const rows = hideEmpty ? all.filter((t) => t.countedCount > 0) : all;
  const set = (patch: Partial<StockTakeFilters>) => setFilters((f) => ({ ...f, ...patch }));

  const run = async (fn: () => Promise<unknown>, what: string) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(`${what}: ${err instanceof Error ? err.message : 'it failed'}`);
    }
  };

  const confirmCancel = (t: StockTakeRow) => {
    const venue = siteName.get(t.siteId) ?? 'this venue';
    const msg =
      t.countedCount > 0
        ? `Cancel the ${venue} count opened ${whenLabel(t.createdAt)}? Its ${t.countedCount} counted lines are kept as a record but will never be applied to stock.`
        : `Cancel the empty ${venue} count opened ${whenLabel(t.createdAt)}?`;
    if (window.confirm(msg)) void run(() => cancel.mutateAsync(t.id), 'Could not cancel the count');
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Stock-takes</h1>
        <p className="mt-1 max-w-3xl text-sm text-[var(--color-muted-foreground)]">
          Every count at every venue: open, approved or cancelled. Open one to see it line by line, or
          download it. A venue has one open count at a time; a count is applied to stock only when a
          manager approves it on the iPad.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="st-venue">Venue</Label>
          <select
            id="st-venue"
            className="h-9 border border-[var(--color-border)] bg-[var(--color-background)] px-2 text-sm"
            value={filters.siteId ?? ''}
            onChange={(e) => set({ siteId: e.target.value || undefined })}
          >
            <option value="">All venues</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="st-status">Status</Label>
          <select
            id="st-status"
            className="h-9 border border-[var(--color-border)] bg-[var(--color-background)] px-2 text-sm"
            value={filters.status ?? ''}
            onChange={(e) => set({ status: e.target.value || undefined })}
          >
            <option value="">Any status</option>
            <option value="OPEN">Open</option>
            <option value="APPROVED">Approved</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="st-from">From</Label>
          <Input
            id="st-from"
            type="date"
            className="w-40"
            value={filters.from ?? ''}
            onChange={(e) => set({ from: e.target.value || undefined })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="st-to">To</Label>
          <Input
            id="st-to"
            type="date"
            className="w-40"
            value={filters.to ?? ''}
            onChange={(e) => set({ to: e.target.value || undefined })}
          />
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />
          Hide counts with nothing counted
        </label>
        <Button
          variant="outline"
          className="ml-auto"
          disabled={downloads.isPending || rows.length === 0}
          onClick={() => void run(() => downloads.mutateAsync({ filters }), 'Could not download')}
        >
          <Download className="h-4 w-4" />
          Download all counted lines
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-[var(--color-destructive)]">
          {error}
        </p>
      )}
      {list.isLoading && <Skeleton className="h-64 w-full" />}
      {list.isError && (
        <p role="alert" className="text-sm text-[var(--color-destructive)]">
          Could not load the counts: {list.error instanceof Error ? list.error.message : 'unknown error'}
        </p>
      )}
      {list.data && rows.length === 0 && (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          No counts {hideEmpty && all.length > 0 ? 'with anything counted ' : ''}match these filters.
        </p>
      )}

      {rows.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm" data-testid="stock-take-table">
              <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)] text-left">
                <tr>
                  <th className="px-3 py-2 font-medium">Venue</th>
                  <th className="px-3 py-2 font-medium">Count</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Opened</th>
                  <th className="px-3 py-2 font-medium">Approved</th>
                  <th className="px-3 py-2 text-right font-medium">Counted</th>
                  <th className="px-3 py-2 font-medium">Counted by</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="border-b border-[var(--color-border)] last:border-b-0">
                    <td className="px-3 py-2 font-medium">{siteName.get(t.siteId) ?? '—'}</td>
                    <td className="px-3 py-2">{SCOPE_LABEL[t.scope] ?? t.scope}</td>
                    <td className="px-3 py-2">
                      <Badge variant={STATUS_BADGE[t.status] ?? 'outline'}>{STATUS_LABEL[t.status] ?? t.status}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      {whenLabel(t.createdAt)}
                      {t.openedByName && (
                        <span className="block text-xs text-[var(--color-muted-foreground)]">by {t.openedByName}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{t.approvedAt ? whenLabel(t.approvedAt) : '—'}</td>
                    <td className="px-3 py-2 text-right">
                      {t.countedCount} of {t.lineCount}
                    </td>
                    <td className="px-3 py-2">{t.counters.join(', ') || '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-2">
                        <Button asChild size="sm" variant="outline">
                          <Link to="/stock-takes/$id" params={{ id: t.id }}>
                            View
                          </Link>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={downloads.isPending}
                          aria-label={`Download ${siteName.get(t.siteId) ?? ''} count opened ${whenLabel(t.createdAt)}`}
                          onClick={() => void run(() => downloads.mutateAsync({ id: t.id }), 'Could not download')}
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                        {mayCancel && t.status === 'OPEN' && (
                          <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => confirmCancel(t)}>
                            Cancel
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
