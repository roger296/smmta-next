import { useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { fmtDate, post, useCampaigns, useEmailMutation, type Campaign } from '@/features/email/api';
import { CampaignBadge, selectClass } from '@/features/email/ui';

export const Route = createFileRoute('/_authed/messaging/campaigns/')({ component: CampaignsPage });

function CampaignsPage() {
  const [status, setStatus] = useState('');
  const { data } = useCampaigns(status || undefined);
  const { data: pending } = useCampaigns('pending_approval');
  const navigate = useNavigate();
  const create = useEmailMutation(() => post<Campaign>('/email/campaigns', { name: `New campaign ${new Date().toLocaleDateString('en-GB')}`, subject: '' }));
  const approve = useEmailMutation((id: string) => post(`/email/campaigns/${id}/approve`));
  const rows = (data ?? []).filter((c) => !c.variantOf);

  return (
    <div className="space-y-4">
      {pending && pending.length > 0 && (
        <Card>
          <CardContent className="space-y-2 p-4">
            <p className="font-medium">Approval queue</p>
            {pending.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Link to="/messaging/campaigns/$id" params={{ id: c.id }} className="underline">{c.name}</Link>
                <span>· {c.audienceCount ?? '?'} contacts · by {c.createdBy}</span>
                <Button size="sm" onClick={() => confirm(`Approve "${c.name}" to ${c.audienceCount} contacts?`) && approve.mutate(c.id)}>Approve</Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <div className="flex gap-2">
        <select aria-label="Filter status" className={selectClass + ' w-56'} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['draft', 'pending_approval', 'scheduled', 'sending', 'paused', 'sent', 'cancelled'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
        <Button onClick={() => create.mutate(undefined, { onSuccess: (c) => navigate({ to: '/messaging/campaigns/$id', params: { id: c.id } }) })}>New campaign</Button>
      </div>
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-[var(--color-border)] text-left"><th className="px-3 py-2">Name</th><th className="px-3 py-2">Kind</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Audience</th><th className="px-3 py-2">Scheduled</th><th className="px-3 py-2">By</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="px-3 py-2"><Link to="/messaging/campaigns/$id" params={{ id: c.id }} className="underline">{c.name}</Link></td>
                  <td className="px-3 py-2">{c.kind.replace('_', ' ')}</td>
                  <td className="px-3 py-2"><CampaignBadge status={c.status} /></td>
                  <td className="px-3 py-2">{c.audienceCount ?? '—'}</td>
                  <td className="px-3 py-2">{fmtDate(c.scheduledAt)}</td>
                  <td className="px-3 py-2">{c.createdBy}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td className="px-3 py-4 text-[var(--color-muted-foreground)]" colSpan={6}>No campaigns yet.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
