import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import {
  type ProductChannelRule,
  useProductChannels,
  useUpdateProductChannels,
} from './use-channels';

interface RowState {
  channelId: string;
  isOffered: boolean;
  /** UI-side string. Empty = "use base price" (no override). */
  priceOverrideStr: string;
}

function ruleToRowState(r: ProductChannelRule): RowState {
  return {
    channelId: r.channelId,
    isOffered: r.isOffered,
    priceOverrideStr: r.priceOverrideGbp ?? '',
  };
}

function isPriceValid(s: string): boolean {
  if (s === '') return true; // empty = no override
  return /^\d+(\.\d{1,2})?$/.test(s.trim());
}

export function ChannelsTab({ productId, basePriceGbp }: { productId: string; basePriceGbp: string | null }) {
  const { toast } = useToast();
  const { data: rules, isLoading } = useProductChannels(productId);
  const updateMutation = useUpdateProductChannels();
  const [rows, setRows] = React.useState<RowState[]>([]);

  React.useEffect(() => {
    if (rules) setRows(rules.map(ruleToRowState));
  }, [rules]);

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (!rules) {
    return <p className="text-sm text-[var(--color-muted-foreground)]">No channels configured.</p>;
  }

  const setRow = (channelId: string, patch: Partial<RowState>) => {
    setRows((prev) => prev.map((r) => (r.channelId === channelId ? { ...r, ...patch } : r)));
  };

  const handleSave = async () => {
    const invalid = rows.find((r) => !isPriceValid(r.priceOverrideStr));
    if (invalid) {
      toast({
        variant: 'destructive',
        title: 'Invalid price',
        description: 'Override prices must be a number with up to 2 decimals.',
      });
      return;
    }
    try {
      await updateMutation.mutateAsync({
        productId,
        input: {
          channels: rows.map((r) => ({
            channelId: r.channelId,
            isOffered: r.isOffered,
            priceOverrideGbp: r.priceOverrideStr.trim() === '' ? null : r.priceOverrideStr.trim(),
          })),
        },
      });
      toast({ title: 'Channels updated' });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Save failed',
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Channels</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Tick which channels this product is offered on. Leave the price blank to use the base
          selling price ({basePriceGbp ? `£${basePriceGbp}` : 'unset'}); enter a number to override
          for that channel only.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Channel</th>
                <th className="px-4 py-2 text-left font-medium">Type</th>
                <th className="px-4 py-2 text-center font-medium">Offered</th>
                <th className="px-4 py-2 text-left font-medium">Price (£)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const rule = rules.find((x) => x.channelId === r.channelId);
                if (!rule) return null;
                const usingBase = r.priceOverrideStr.trim() === '';
                return (
                  <tr
                    key={r.channelId}
                    className="border-b border-[var(--color-border)] last:border-b-0"
                  >
                    <td className="px-4 py-2">{rule.channelDisplayName}</td>
                    <td className="px-4 py-2 text-[var(--color-muted-foreground)]">
                      {rule.channelKind === 'STOREFRONT' ? 'Storefront' : 'Marketplace'}
                    </td>
                    <td className="px-4 py-2 text-center">
                      <input
                        type="checkbox"
                        aria-label={`Offered on ${rule.channelDisplayName}`}
                        checked={r.isOffered}
                        onChange={(e) => setRow(r.channelId, { isOffered: e.target.checked })}
                      />
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <Input
                          aria-label={`Price override for ${rule.channelDisplayName}`}
                          className="w-28"
                          placeholder={basePriceGbp ?? '—'}
                          value={r.priceOverrideStr}
                          disabled={!r.isOffered}
                          onChange={(e) =>
                            setRow(r.channelId, { priceOverrideStr: e.target.value })
                          }
                        />
                        {usingBase && (
                          <span className="text-xs text-[var(--color-muted-foreground)]">
                            uses base
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={updateMutation.isPending}>
            {updateMutation.isPending ? 'Saving…' : 'Save channel rules'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
