import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { type Listed, type OptionRow, useBuyingDataHealth } from '@/features/buying-data/use-buying-data';

export const Route = createFileRoute('/_authed/buying-data')({
  component: BuyingDataPage,
});

const money = (n: number | string | null): string => (n == null ? '—' : `£${Number(n).toFixed(2)}`);
const day = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

/**
 * Buying data (supplier-ordering groundwork, plan §5.2).
 *
 * Ordering will rank buying options by what an item costs per stock unit and
 * when it would arrive. An option with no pack size, no price, or a supplier
 * that cannot be dated for a venue does not fail — it quietly drops out of the
 * comparison, or wins on an old price. This is the list of those, biggest
 * spend first, to work down before ordering relies on them.
 */
export function BuyingDataPage() {
  const { data, isLoading, isError, error } = useBuyingDataHealth();

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (isError || !data) {
    return (
      <p role="alert" className="text-sm text-[var(--color-destructive)]">
        Could not load: {error instanceof Error ? error.message : 'unknown error'}
      </p>
    );
  }
  const { thresholds: t } = data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Buying data</h1>
        <p className="mt-1 max-w-3xl text-sm text-[var(--color-muted-foreground)]">
          What would stop ordering comparing like with like. Each list is biggest spend first
          (spend is what the invoices show under that code over the last year). Work them down
          before ordering relies on them.
        </p>
      </div>

      <Section
        title="Pack size missing"
        testId="pack-size-missing"
        why="Without a numeric pack size an option cannot be priced per kilo, litre or item, so it cannot be compared with any other way of buying the same thing. Set it on the product's Suppliers tab."
        list={data.packSizeMissing}
        render={(r) => <OptionCells row={r} />}
        head={OPTION_HEAD}
      />

      <Section
        title="Suppliers not set up for every venue"
        testId="supplier-accounts"
        why="Without delivery days or a lead time for a venue, ordering cannot say when an order would arrive there. Set them on the supplier's Venues & delivery tab."
        list={data.supplierAccounts}
        head={['Supplier', 'Things to buy', 'Venues set up', 'Spend seen']}
        render={(r) => (
          <>
            <td className="px-3 py-2">
              <Link to="/suppliers/$id" params={{ id: r.supplierId }} className="hover:underline">
                {r.supplierName}
              </Link>
            </td>
            <td className="px-3 py-2 text-right">{r.options}</td>
            <td className="px-3 py-2 text-right">
              {r.venuesDatable} of {r.venues}
            </td>
            <td className="px-3 py-2 text-right">{money(r.spendSeen12m)}</td>
          </>
        )}
      />

      <Section
        title="Price moves"
        testId="price-moves"
        why={`The last two invoices under the code differ by more than ${Math.round(t.priceMoveAlert * 100)}%. Either the price changed or one of the readings is wrong.`}
        list={data.priceMoves}
        head={['Product', 'Supplier', 'Code', 'Was', 'Now', 'Change']}
        render={(r) => (
          <>
            <ProductCell row={r} />
            <td className="px-3 py-2">{r.supplierName}</td>
            <td className="px-3 py-2 font-mono text-xs">{r.supplierSku}</td>
            <td className="px-3 py-2 text-right">{money(r.previousPrice)}</td>
            <td className="px-3 py-2 text-right">{money(r.lastPrice)}</td>
            <td className="px-3 py-2 text-right">
              <Badge variant={r.change > 0 ? 'destructive' : 'secondary'}>
                {r.change > 0 ? '+' : ''}
                {Math.round(r.change * 100)}%
              </Badge>
            </td>
          </>
        )}
      />

      <Section
        title={`Stale prices (over ${t.stalePriceDays} days)`}
        testId="stale-price"
        why="Last seen on an invoice a while ago. Check it before an order is placed on it."
        list={data.stalePrice}
        render={(r) => <OptionCells row={r} />}
        head={OPTION_HEAD}
      />

      <Section
        title="No price at all"
        testId="no-price"
        why="No cost typed in and never seen on an invoice."
        list={data.noPrice}
        render={(r) => <OptionCells row={r} />}
        head={OPTION_HEAD}
      />

      <Section
        title="Stocked, but nothing to buy it as"
        testId="no-buying-option"
        why="No supplier code at all. Ones with a reorder point come first: they will raise a reorder suggestion with no supplier."
        list={data.noBuyingOption}
        head={['Product', 'Stock code', '']}
        render={(r) => (
          <>
            <td className="px-3 py-2">
              <Link to="/products/$id" params={{ id: r.productId }} className="hover:underline">
                {r.productName}
              </Link>
            </td>
            <td className="px-3 py-2 font-mono text-xs">{r.stockCode ?? '—'}</td>
            <td className="px-3 py-2">{r.hasReorderPoint && <Badge variant="destructive">has a reorder point</Badge>}</td>
          </>
        )}
      />
    </div>
  );
}

const OPTION_HEAD = ['Product', 'Supplier', 'Code', 'Cost', 'Last paid', 'Spend seen'];

function ProductCell({ row }: { row: OptionRow }) {
  return (
    <td className="px-3 py-2">
      <Link to="/products/$id" params={{ id: row.productId }} className="hover:underline">
        {row.productName}
      </Link>
      {row.stockCode && <span className="block font-mono text-xs text-[var(--color-muted-foreground)]">{row.stockCode}</span>}
    </td>
  );
}

function OptionCells({ row }: { row: OptionRow }) {
  return (
    <>
      <ProductCell row={row} />
      <td className="px-3 py-2">{row.supplierName}</td>
      <td className="px-3 py-2 font-mono text-xs">{row.supplierSku}</td>
      <td className="px-3 py-2 text-right">{money(row.costGbp)}</td>
      <td className="px-3 py-2 text-right">
        {money(row.lastPrice)}
        {row.lastPriceAt && <span className="block text-xs text-[var(--color-muted-foreground)]">{day(row.lastPriceAt)}</span>}
      </td>
      <td className="px-3 py-2 text-right">{money(row.spendSeen12m)}</td>
    </>
  );
}

function Section<T>({
  title,
  why,
  list,
  head,
  render,
  testId,
}: {
  title: string;
  why: string;
  list: Listed<T>;
  head: string[];
  render: (row: T) => React.ReactNode;
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {title}
          <Badge variant={list.total === 0 ? 'secondary' : 'destructive'}>{list.total}</Badge>
        </CardTitle>
        <p className="text-sm text-[var(--color-muted-foreground)]">{why}</p>
      </CardHeader>
      <CardContent className="p-0">
        {list.total === 0 ? (
          <p className="px-6 pb-6 text-sm text-[var(--color-muted-foreground)]">Nothing here.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                <tr>
                  {head.map((h, i) => (
                    <th key={i} className="px-3 py-2 text-left font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.rows.map((row, i) => (
                  <tr key={i} className="border-b border-[var(--color-border)] last:border-b-0">
                    {render(row)}
                  </tr>
                ))}
              </tbody>
            </table>
            {list.rows.length < list.total && (
              <p className="px-3 py-2 text-xs text-[var(--color-muted-foreground)]">
                Showing the first {list.rows.length} of {list.total}.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
