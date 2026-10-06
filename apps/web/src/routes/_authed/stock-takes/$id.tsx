import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useSiteContext } from '@/features/sites/site-context';
import { useRoles } from '@/features/auth/use-roles';
import {
  SCOPE_LABEL,
  STATUS_LABEL,
  type StockTakeLine,
  useCancelStockTake,
  useStockTakeDetail,
  useStockTakeDownloads,
  whenLabel,
} from '@/features/stock-takes/use-stock-takes';
import { ArrowLeft, Download } from 'lucide-react';

export const Route = createFileRoute('/_authed/stock-takes/$id')({
  component: StockTakeDetailRoute,
});

function StockTakeDetailRoute() {
  const { id } = Route.useParams();
  return <StockTakeDetailPage id={id} />;
}

const UNCATEGORISED = 'Uncategorised';
const n = (v: string | null): number | null => (v == null ? null : Number(v));
const qty = (v: number | null): string => (v == null ? '—' : String(Math.round(v * 1000) / 1000));

/** Section, then name — the order the count screen and the download use. */
function byScreenOrder(a: StockTakeLine, b: StockTakeLine): number {
  const sa = a.itemCategoryName ?? UNCATEGORISED;
  const sb = b.itemCategoryName ?? UNCATEGORISED;
  if (sa !== sb) {
    if (sa === UNCATEGORISED) return 1;
    if (sb === UNCATEGORISED) return -1;
    return sa.localeCompare(sb);
  }
  return (a.productName ?? '').localeCompare(b.productName ?? '');
}

/**
 * One count, line by line, for head office: book, counted, variance, who and
 * when. Read-only — counting and approving happen on the iPad — apart from
 * Cancel, for a manager setting an open count aside.
 */
export function StockTakeDetailPage({ id }: { id: string }) {
  const { sites } = useSiteContext();
  const { can } = useRoles();
  const detail = useStockTakeDetail(id);
  const downloads = useStockTakeDownloads();
  const cancel = useCancelStockTake();
  const [show, setShow] = React.useState<'all' | 'counted' | 'todo'>('counted');
  const [search, setSearch] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  if (detail.isLoading) return <Skeleton className="h-96 w-full" />;
  if (detail.isError || !detail.data) {
    return (
      <p role="alert" className="text-sm text-[var(--color-destructive)]">
        Could not load this count: {detail.error instanceof Error ? detail.error.message : 'not found'}
      </p>
    );
  }
  const { take, lines } = detail.data;
  const venue = sites.find((s) => s.id === take.siteId)?.name ?? 'Venue';
  const counted = lines.filter((l) => l.countedQty != null);
  const differ = counted.filter((l) => Number(l.variance ?? 0) !== 0);
  const counters = [...new Set(counted.map((l) => l.countedByName).filter(Boolean))].sort() as string[];
  const q = search.trim().toLowerCase();
  const visible = lines
    .filter((l) => (show === 'counted' ? l.countedQty != null : show === 'todo' ? l.countedQty == null : true))
    .filter((l) => !q || `${l.productName ?? ''} ${l.stockCode ?? ''}`.toLowerCase().includes(q))
    .sort(byScreenOrder);

  const doCancel = async () => {
    const msg =
      counted.length > 0
        ? `Cancel this ${venue} count? Its ${counted.length} counted lines are kept as a record but will never be applied to stock.`
        : `Cancel this empty ${venue} count?`;
    if (!window.confirm(msg)) return;
    setError(null);
    try {
      await cancel.mutateAsync(take.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel the count.');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <Link to="/stock-takes" className="inline-flex items-center gap-1 text-sm text-[var(--color-muted-foreground)]">
          <ArrowLeft className="h-4 w-4" /> All stock-takes
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">
            {venue} · {SCOPE_LABEL[take.scope] ?? take.scope}
          </h1>
          <Badge variant={take.status === 'OPEN' ? 'default' : take.status === 'APPROVED' ? 'secondary' : 'outline'}>
            {STATUS_LABEL[take.status] ?? take.status}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]" data-testid="take-summary">
          Opened {whenLabel(take.createdAt)}
          {take.openedByName ? ` by ${take.openedByName}` : ''}
          {take.approvedAt ? ` · approved ${whenLabel(take.approvedAt)}` : ''} · {counted.length} of {lines.length}{' '}
          counted
          {counters.length > 0 ? ` by ${counters.join(', ')}` : ''} · {differ.length} differ from book
        </p>
        {take.status === 'OPEN' && (
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            Still open: nothing here has been applied to stock yet. It is approved on the iPad.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ['counted', `Counted (${counted.length})`],
            ['todo', `Not counted (${lines.length - counted.length})`],
            ['all', `All (${lines.length})`],
          ] as const
        ).map(([key, label]) => (
          <Button key={key} size="sm" variant={show === key ? 'default' : 'outline'} onClick={() => setShow(key)}>
            {label}
          </Button>
        ))}
        <Input
          placeholder="Search product or code…"
          aria-label="Search lines"
          className="max-w-xs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="ml-auto flex gap-2">
          {can(['site_manager']) && take.status === 'OPEN' && (
            <Button variant="outline" disabled={cancel.isPending} onClick={() => void doCancel()}>
              Cancel this count
            </Button>
          )}
          <Button
            disabled={downloads.isPending}
            onClick={() =>
              void downloads.mutateAsync({ id: take.id }).catch((err: unknown) =>
                setError(err instanceof Error ? err.message : 'Could not download.'),
              )
            }
          >
            <Download className="h-4 w-4" />
            Download spreadsheet
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-[var(--color-destructive)]">
          {error}
        </p>
      )}

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm" data-testid="take-lines">
            <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)] text-left">
              <tr>
                <th className="px-3 py-2 font-medium">Section</th>
                <th className="px-3 py-2 font-medium">Product</th>
                <th className="px-3 py-2 font-medium">Unit</th>
                <th className="px-3 py-2 text-right font-medium">Book</th>
                <th className="px-3 py-2 text-right font-medium">Counted</th>
                <th className="px-3 py-2 text-right font-medium">Variance</th>
                <th className="px-3 py-2 font-medium">Counted by</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-[var(--color-muted-foreground)]">
                    Nothing to show.
                  </td>
                </tr>
              )}
              {visible.map((l) => {
                const v = l.countedQty == null ? null : n(l.variance);
                return (
                  <tr key={l.productId} className="border-b border-[var(--color-border)] last:border-b-0">
                    <td className="px-3 py-2 text-[var(--color-muted-foreground)]">{l.itemCategoryName ?? UNCATEGORISED}</td>
                    <td className="px-3 py-2">
                      {l.productName ?? 'Unknown product'}
                      {l.stockCode && (
                        <span className="block text-xs text-[var(--color-muted-foreground)]">{l.stockCode}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{l.stockUom ?? ''}</td>
                    <td className="px-3 py-2 text-right">{qty(n(l.bookQty))}</td>
                    <td className="px-3 py-2 text-right font-medium">{qty(n(l.countedQty))}</td>
                    <td
                      className={`px-3 py-2 text-right ${v != null && v !== 0 ? 'text-[var(--color-destructive)]' : ''}`}
                    >
                      {v == null ? '—' : `${v > 0 ? '+' : ''}${qty(v)}`}
                    </td>
                    <td className="px-3 py-2">
                      {l.countedByName ?? (l.countedQty != null ? '(no name)' : '—')}
                      {l.countedAt && (
                        <span className="block text-xs text-[var(--color-muted-foreground)]">{whenLabel(l.countedAt)}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
