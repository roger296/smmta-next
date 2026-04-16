import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { STOCK_STATUSES, useSerialLookup } from '@/features/stock/use-stock';
import { formatMoney } from '@/lib/format';
import { Search } from 'lucide-react';

export const Route = createFileRoute('/_authed/stock/serial')({
  component: SerialLookupPage,
});

function SerialLookupPage() {
  const [input, setInput] = React.useState('');
  const [submittedSerial, setSubmittedSerial] = React.useState<string>();
  const { data, isLoading, isError } = useSerialLookup(submittedSerial);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Serial number lookup</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Enter a serial number to find the matching stock item.
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim()) setSubmittedSerial(input.trim());
        }}
        className="flex gap-2"
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. SN-12345"
          aria-label="Serial number"
        />
        <Button type="submit" disabled={!input.trim()}>
          <Search className="h-4 w-4" />
          Search
        </Button>
      </form>
      {submittedSerial && (
        <Card>
          <CardHeader>
            <CardTitle>Result for {submittedSerial}</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading && <p className="text-sm text-[var(--color-muted-foreground)]">Searching…</p>}
            {isError && (
              <p role="alert" className="text-sm text-[var(--color-destructive)]">
                Lookup failed.
              </p>
            )}
            {!isLoading && !isError && data === null && (
              <p className="text-sm text-[var(--color-muted-foreground)]">
                No stock item with that serial number.
              </p>
            )}
            {!isLoading && data && (
              <dl className="grid gap-3 text-sm md:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">
                    Product
                  </dt>
                  <dd>{data.productName ?? data.productId}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">
                    Warehouse
                  </dt>
                  <dd>{data.warehouseName ?? data.warehouseId}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">
                    Status
                  </dt>
                  <dd>
                    <Badge
                      variant={
                        (STOCK_STATUSES.find((s) => s.value === data.status)?.color ?? 'outline') as
                          | 'default'
                          | 'secondary'
                          | 'destructive'
                          | 'outline'
                      }
                    >
                      {STOCK_STATUSES.find((s) => s.value === data.status)?.label ?? data.status}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">
                    Value
                  </dt>
                  <dd>{formatMoney(data.valuePerUnit, data.currencyCode)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">
                    Linked to order
                  </dt>
                  <dd>{data.orderId ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-[var(--color-muted-foreground)]">
                    Location
                  </dt>
                  <dd>
                    {[data.locationIsle, data.locationShelf, data.locationBin]
                      .filter(Boolean)
                      .join(' / ') || '—'}
                  </dd>
                </div>
              </dl>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
