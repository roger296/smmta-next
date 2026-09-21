import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ScanBarcode, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/api-client';
import type { Order, SerialScanProgress, SerialScanResult } from '@/lib/api-types';

const SHIPPED_STATUSES = ['SHIPPED', 'PARTIALLY_SHIPPED', 'COMPLETED'];
const progressKey = (orderId: string) => ['orders', 'detail', orderId, 'serial-scan'];

/**
 * Scanning serial-tracked units onto an order before it ships.
 *
 * Built for a barcode scanner: the box keeps the focus, a scan ends with Enter,
 * and the result is said in words straight away, so the dispatcher can scan a
 * pallet's worth without touching the mouse. The scanned unit takes the place
 * of whichever one the system had allocated. Renders nothing for an order with
 * no serial-tracked products.
 */
export function SerialScanCard({ order }: { order: Order }) {
  const qc = useQueryClient();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [code, setCode] = React.useState('');
  const [last, setLast] = React.useState<{ ok: boolean; text: string } | null>(null);
  const shipped = SHIPPED_STATUSES.includes(order.status);

  const { data: progress } = useQuery<SerialScanProgress>({
    queryKey: progressKey(order.id),
    queryFn: () => apiFetch<SerialScanProgress>(`/orders/${order.id}/serial-scan`),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['orders', 'detail', order.id] });

  const scan = useMutation({
    mutationFn: (value: string) => apiFetch<SerialScanResult>(`/orders/${order.id}/serial-scan`, { method: 'POST', body: { code: value } }),
    onSuccess: (result) => setLast({ ok: true, text: result.message }),
    onError: (err) => setLast({ ok: false, text: err instanceof Error ? err.message : 'That scan did not work.' }),
    onSettled: () => {
      setCode('');
      inputRef.current?.focus();
      void refresh();
    },
  });

  const unscan = useMutation({
    mutationFn: (stockItemId: string) => apiFetch(`/orders/${order.id}/serial-scan/${stockItemId}`, { method: 'DELETE' }),
    onSettled: () => void refresh(),
  });

  if (!progress?.required) return null;

  return (
    <Card data-test="serial-scan-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ScanBarcode className="h-4 w-4" />
          Serial numbers
          {progress.complete && (
            <span className="flex items-center gap-1 text-sm font-normal text-[var(--color-muted-foreground)]">
              <Check className="h-3 w-3" /> all scanned
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!shipped && !progress.complete && (
          <form
            className="flex max-w-md gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim()) scan.mutate(code);
            }}
          >
            <Input
              ref={inputRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Scan or type a serial number"
              aria-label="Serial number"
              autoComplete="off"
              data-test="serial-scan-input"
            />
            <Button size="sm" type="submit" disabled={scan.isPending || !code.trim()}>
              Scan
            </Button>
          </form>
        )}
        {last && (
          <p role="status" className={last.ok ? '' : 'text-[var(--color-destructive)]'} data-test="serial-scan-result">
            {last.text}
          </p>
        )}
        <ul className="space-y-2">
          {progress.lines.map((line) => (
            <li key={line.productId}>
              <p>
                <span className="font-medium">{line.sku ?? line.name}</span>{' '}
                <span className="text-[var(--color-muted-foreground)]">
                  {line.scanned.length} of {line.needed} scanned
                </span>
              </p>
              {line.scanned.length > 0 && (
                <ul className="mt-1 flex flex-wrap gap-2">
                  {line.scanned.map((s) => (
                    <li key={s.stockItemId} className="flex items-center gap-1 border border-[var(--color-border)] px-2 py-0.5 font-mono">
                      {s.serialNumber}
                      {!shipped && (
                        <button
                          type="button"
                          aria-label={`Take back the scan of ${s.serialNumber}`}
                          className="text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
                          onClick={() => unscan.mutate(s.stockItemId)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        {!shipped && !progress.complete && (
          <p className="text-[var(--color-muted-foreground)]">
            Scan the units going in the box. If one is not the unit the system allocated, it takes that unit’s place
            and the other goes back to stock.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
