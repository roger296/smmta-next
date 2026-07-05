import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import { Inbox } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  useQueue,
  useDraftDetail,
  useApproveDraft,
  useRejectDraft,
  useResolveEscalation,
  type QueueItem,
  type RejectReason,
} from '@/features/approval/use-approval';

/**
 * Approval queue (SPEC §17) — the owner's inbox. Priority-ordered drafts +
 * escalations; a facts panel above the prose; one-tap approve, reject-with-
 * reason, and resolve. Sits inside the authenticated layout.
 */
export const Route = createFileRoute('/_authed/approval/')({
  component: ApprovalPage,
});

const REJECT_REASONS: RejectReason[] = ['wrong_facts', 'wrong_tone', 'should_not_send', 'other'];

function ApprovalPage() {
  const { data: items, isLoading } = useQueue();
  const resolveEsc = useResolveEscalation();

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Approval queue</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Agent-drafted messages and escalations, most urgent first.
        </p>
      </div>

      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      )}

      {items && items.length === 0 && (
        <EmptyState icon={Inbox} title="All clear" description="Nothing awaiting your review right now." />
      )}

      <div className="space-y-3">
        {items?.map((item) =>
          item.type === 'escalation' ? (
            <Card key={item.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{item.subject}</CardTitle>
                  <Badge variant="destructive">escalation</Badge>
                </div>
              </CardHeader>
              <CardContent className="flex justify-end">
                <Button size="sm" onClick={() => resolveEsc.mutate(item.id)} disabled={resolveEsc.isPending}>
                  Mark resolved
                </Button>
              </CardContent>
            </Card>
          ) : (
            <DraftCard key={item.id} item={item} />
          ),
        )}
      </div>
    </div>
  );
}

function DraftCard({ item }: { item: QueueItem }) {
  const [showFacts, setShowFacts] = React.useState(false);
  const [reason, setReason] = React.useState<RejectReason>('wrong_facts');
  const { toast } = useToast();
  const approve = useApproveDraft();
  const reject = useRejectDraft();
  const { data: detail } = useDraftDetail(item.id, showFacts);

  const busy = approve.isPending || reject.isPending;
  const expired = item.expiresInMs != null && item.expiresInMs <= 0;
  const expiryLabel =
    item.expiresInMs != null
      ? expired
        ? 'expired'
        : `expires in ${Math.round(item.expiresInMs / 3_600_000)}h`
      : null;

  const onApprove = () =>
    approve.mutate(item.id, {
      onSuccess: () => toast({ title: 'Approved', description: 'Queued to send.' }),
      onError: () => toast({ title: 'Could not approve', variant: 'destructive' }),
    });
  const onReject = () =>
    reject.mutate(
      { id: item.id, reason },
      {
        onSuccess: () => toast({ title: 'Rejected' }),
        onError: () => toast({ title: 'Could not reject', variant: 'destructive' }),
      },
    );

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{item.subject}</CardTitle>
          <div className="flex shrink-0 gap-1">
            <Badge variant="secondary">{item.groupKey?.split(':')[0] ?? item.category}</Badge>
            {expiryLabel && <Badge variant={expired ? 'destructive' : 'outline'}>{expiryLabel}</Badge>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setShowFacts((s) => !s)}>
          {showFacts ? 'Hide facts' : 'Review facts'}
        </Button>
        {showFacts && detail && (
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] p-3 text-xs">
            <p className="mb-1 font-medium">Trigger: {detail.facts?.eventType ?? 'n/a'}</p>
            <pre className="overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(detail.facts?.payload ?? {}, null, 2)}
            </pre>
            <p className="mt-2 whitespace-pre-wrap border-t border-[var(--color-border)] pt-2">{detail.draft.body}</p>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={onApprove} disabled={busy} className="flex-1">
            Approve
          </Button>
          <Select value={reason} onValueChange={(v) => setReason(v as RejectReason)}>
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REJECT_REASONS.map((r) => (
                <SelectItem key={r} value={r}>
                  {r.replace(/_/g, ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="destructive" onClick={onReject} disabled={busy}>
            Reject
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
