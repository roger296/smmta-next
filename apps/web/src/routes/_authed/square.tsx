import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Square } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/empty-state';
import { useToast } from '@/hooks/use-toast';
import {
  useSquareMap,
  useSquareUnmapped,
  useUpsertSquareMap,
} from '@/features/square/use-square';

export const Route = createFileRoute('/_authed/square')({
  component: SquarePage,
});

function SquarePage() {
  const { data: map } = useSquareMap();
  const { data: unmapped } = useSquareUnmapped();
  const upsert = useUpsertSquareMap();
  const { toast } = useToast();
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});

  const mapItem = async (squareKey: string) => {
    const productId = drafts[squareKey]?.trim();
    if (!productId) return;
    try {
      await upsert.mutateAsync([{ squareKey, productId }]);
      toast({ title: `Mapped ${squareKey}` });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Mapping failed', description: String(err) });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Square item mapping</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Map Square catalogue items to stock products so sales decrement the right SKU. Unmapped
          sale lines are quarantined here, never dropped.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Unmapped sale lines {unmapped && unmapped.length > 0 ? `(${unmapped.length})` : ''}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {unmapped && unmapped.length === 0 ? (
            <div className="p-6">
              <EmptyState icon={Square} title="Nothing to map" description="All sale lines resolved." />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted-foreground)]">
                  <th className="px-4 py-3 font-medium">Square key</th>
                  <th className="px-4 py-3 font-medium">Reason</th>
                  <th className="px-4 py-3 font-medium">Qty</th>
                  <th className="px-4 py-3 font-medium">Map to product id</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {unmapped?.map((u) => (
                  <tr key={u.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="px-4 py-3 font-mono text-xs">{u.squareKey ?? '—'}</td>
                    <td className="px-4 py-3">{u.reason}</td>
                    <td className="px-4 py-3 tabular-nums">{Number(u.qty)}</td>
                    <td className="px-4 py-2">
                      <Input
                        className="h-8 w-72 font-mono text-xs"
                        placeholder="product uuid"
                        value={drafts[u.squareKey ?? ''] ?? ''}
                        onChange={(e) =>
                          setDrafts((d) => ({ ...d, [u.squareKey ?? '']: e.target.value }))
                        }
                        disabled={!u.squareKey}
                      />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button
                        size="sm"
                        disabled={!u.squareKey || upsert.isPending}
                        onClick={() => u.squareKey && mapItem(u.squareKey)}
                      >
                        Map
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Current map</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted-foreground)]">
                <th className="px-4 py-3 font-medium">Square key</th>
                <th className="px-4 py-3 font-medium">Product id</th>
                <th className="px-4 py-3 font-medium">Matched</th>
              </tr>
            </thead>
            <tbody>
              {map?.map((m) => (
                <tr key={m.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="px-4 py-3 font-mono text-xs">{m.squareKey}</td>
                  <td className="px-4 py-3 font-mono text-xs">{m.productId}</td>
                  <td className="px-4 py-3">
                    <Badge variant={m.autoMatched ? 'default' : 'secondary'}>
                      {m.autoMatched ? 'auto' : 'manual'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
