import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { RefreshCw, ShoppingBag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  useReorderProposals,
  useApproveProposal,
  usePlaceProposal,
  useRunReorderSweep,
  type ReorderProposal,
} from '@/features/reorder/use-reorder';

export const Route = createFileRoute('/_authed/reorder')({
  component: ReorderPage,
});

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive'> = {
  PROPOSED: 'secondary',
  APPROVED: 'default',
  PLACED: 'default',
  EMAILED: 'default',
  REJECTED: 'destructive',
  CANCELLED: 'destructive',
};

function ReorderPage() {
  const [status, setStatus] = React.useState<string>('PROPOSED');
  const { data: proposals, isLoading } = useReorderProposals(status === 'ALL' ? undefined : status);
  const approve = useApproveProposal();
  const place = usePlaceProposal();
  const sweep = useRunReorderSweep();
  const { toast } = useToast();

  const runSweep = async () => {
    try {
      const r = await sweep.mutateAsync();
      toast({ title: `Sweep complete — ${r.created} new proposal(s) from ${r.evaluated} low items` });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Sweep failed', description: String(err) });
    }
  };

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast({ title: ok });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Action failed', description: String(err) });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Reorder suggestions</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Replenishment proposals raised when stock hits its reorder point. Approve and place
            (emailed PO) the ones you want; auto-place suppliers are placed automatically.
          </p>
        </div>
        <Button variant="outline" onClick={runSweep} disabled={sweep.isPending}>
          <RefreshCw className="h-4 w-4" />
          {sweep.isPending ? 'Sweeping…' : 'Run sweep'}
        </Button>
      </div>

      <div className="w-48">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="PROPOSED">Proposed</SelectItem>
            <SelectItem value="APPROVED">Approved</SelectItem>
            <SelectItem value="EMAILED">Emailed</SelectItem>
            <SelectItem value="PLACED">Placed</SelectItem>
            <SelectItem value="ALL">All</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading && (
        <Card>
          <CardContent className="space-y-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      )}

      {!isLoading && proposals && proposals.length === 0 && (
        <EmptyState
          icon={ShoppingBag}
          title="No proposals"
          description="Replenishments appear here as stock falls to its reorder point."
        />
      )}

      {!isLoading && proposals && proposals.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted-foreground)]">
                  <th className="px-4 py-3 font-medium">Qty</th>
                  <th className="px-4 py-3 font-medium">Channel</th>
                  <th className="px-4 py-3 font-medium">Trigger</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Ref</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {proposals.map((p: ReorderProposal) => (
                  <tr key={p.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="px-4 py-3 tabular-nums">
                      {p.suggestedQtyPurchase ? Number(p.suggestedQtyPurchase) : Number(p.suggestedQtyStock)}{' '}
                      {p.purchaseUom ?? ''}
                    </td>
                    <td className="px-4 py-3">{p.channel ?? '—'}</td>
                    <td className="px-4 py-3 text-xs">{p.triggeredBy}</td>
                    <td className="px-4 py-3">
                      <Badge variant={STATUS_VARIANT[p.status] ?? 'secondary'}>{p.status}</Badge>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{p.supplierOrderRef ?? '—'}</td>
                    <td className="px-4 py-3 text-right">
                      {p.status === 'PROPOSED' && (
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => act(() => approve.mutateAsync(p.id), 'Approved')}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => act(() => place.mutateAsync(p.id), 'Placed')}
                          >
                            Place
                          </Button>
                        </div>
                      )}
                      {p.status === 'APPROVED' && (
                        <Button size="sm" onClick={() => act(() => place.mutateAsync(p.id), 'Placed')}>
                          Place
                        </Button>
                      )}
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
