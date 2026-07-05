import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Sparkles, Plus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import {
  useProspective,
  useCreateProspective,
  useUpdateProspective,
  type Prospective,
  type ProspectiveStatus,
} from '@/features/prospective/use-prospective';

/** Coming-soon / prospective products (SPEC F8). The operator curates what
 *  customers can register interest in; a threshold triggers a purchase decision. */
export const Route = createFileRoute('/_authed/prospective/')({
  component: ProspectivePage,
});

const STATUSES: ProspectiveStatus[] = ['considering', 'group_buy_open', 'ordered', 'ranged', 'abandoned'];

function ProspectivePage() {
  const { data: items, isLoading } = useProspective();
  const [creating, setCreating] = React.useState(false);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Coming soon</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">Prospective products + group-buy demand signals.</p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="mr-1 h-4 w-4" /> New
        </Button>
      </div>

      {isLoading && <Skeleton className="h-24 w-full" />}
      {items && items.length === 0 && (
        <EmptyState icon={Sparkles} title="No prospective products" description="Add one to start gathering interest." />
      )}

      <div className="space-y-3">
        {items?.map((p) => (
          <ProspectiveCard key={p.id} item={p} />
        ))}
      </div>

      <CreateDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function ProspectiveCard({ item }: { item: Prospective }) {
  const { toast } = useToast();
  const update = useUpdateProspective();
  const pct = item.interestThreshold ? Math.min(100, Math.round((item.interestCount / item.interestThreshold) * 100)) : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{item.name}</CardTitle>
          <div className="flex shrink-0 items-center gap-2">
            {item.thresholdCrossedAt && <Badge>threshold met</Badge>}
            <Select
              value={item.status}
              onValueChange={(v) =>
                update.mutate(
                  { id: item.id, status: v as ProspectiveStatus },
                  { onSuccess: () => toast({ title: 'Updated' }), onError: () => toast({ title: 'Failed', variant: 'destructive' }) },
                )
              }
            >
              <SelectTrigger className="h-8 w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s.replace(/_/g, ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {item.creatorPartner && <p className="text-[var(--color-muted-foreground)]">with {item.creatorPartner}</p>}
        {item.interestThreshold != null ? (
          <div>
            <div className="flex justify-between text-xs text-[var(--color-muted-foreground)]">
              <span>{item.interestCount} of {item.interestThreshold} interested</span>
              <span>{pct}%</span>
            </div>
            <div className="mt-1 h-2 w-full rounded bg-[var(--color-muted)]">
              <div className="h-2 rounded bg-[var(--color-accent)]" style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : (
          <p className="text-[var(--color-muted-foreground)]">{item.interestCount} interested (no threshold set)</p>
        )}
      </CardContent>
    </Card>
  );
}

function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateProspective();
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [threshold, setThreshold] = React.useState('');
  const [partner, setPartner] = React.useState('');

  const submit = () => {
    if (!name.trim()) {
      toast({ title: 'Name is required', variant: 'destructive' });
      return;
    }
    create.mutate(
      {
        name: name.trim(),
        description: description.trim() || undefined,
        interestThreshold: threshold ? Number(threshold) : undefined,
        creatorPartner: partner.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast({ title: 'Added' });
          onClose();
          setName('');
          setDescription('');
          setThreshold('');
          setPartner('');
        },
        onError: () => toast({ title: 'Could not add', variant: 'destructive' }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New prospective product</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="pname">Name</Label>
            <Input id="pname" value={name} onChange={(e) => setName(e.target.value)} placeholder="Carbon-Fibre Nylon 1.75mm" />
          </div>
          <div>
            <Label htmlFor="pdesc">Description</Label>
            <Textarea id="pdesc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <Label htmlFor="pthr">Interest threshold</Label>
              <Input id="pthr" type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="40" />
            </div>
            <div className="flex-1">
              <Label htmlFor="ppart">Creator partner</Label>
              <Input id="ppart" value={partner} onChange={(e) => setPartner(e.target.value)} placeholder="optional" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
