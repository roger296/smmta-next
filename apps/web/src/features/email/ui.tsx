/** Small shared pieces for the Messaging pages. */
import { Badge } from '@/components/ui/badge';
import type { CampaignStatus, Deliverability, MarketingStatus } from './api';
import { STATUS_LABEL } from './api';

export function StatusBadge({ status }: { status: MarketingStatus }) {
  return <Badge variant={status === 'all' ? 'default' : status === 'never' ? 'destructive' : 'secondary'}>{STATUS_LABEL[status]}</Badge>;
}

export function DeliverabilityBadge({ d }: { d: Deliverability }) {
  return <Badge variant={d === 'ok' ? 'outline' : d === 'soft_bounce' ? 'secondary' : 'destructive'}>{d.replace('_', ' ')}</Badge>;
}

export function CampaignBadge({ status }: { status: CampaignStatus }) {
  const v = status === 'sent' ? 'outline' : status === 'cancelled' ? 'secondary' : status === 'pending_approval' ? 'destructive' : 'default';
  return <Badge variant={v}>{status.replace('_', ' ')}</Badge>;
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-[var(--color-muted-foreground)]">{hint}</span> : null}
    </label>
  );
}

export const selectClass = 'h-10 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 text-sm';

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}
