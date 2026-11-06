import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { fmtDate, post, STATUS_LABEL, useContact, useEmailMutation, type MarketingStatus } from '@/features/email/api';
import { DeliverabilityBadge, StatusBadge, selectClass, errorText } from '@/features/email/ui';

export const Route = createFileRoute('/_authed/messaging/contacts/$id')({ component: ContactPage });

function ContactPage() {
  const { id } = Route.useParams();
  const { data, error } = useContact(id);
  const [status, setStatus] = useState<MarketingStatus>('transactional_only');
  const [reason, setReason] = useState('');
  const change = useEmailMutation((v: { status: MarketingStatus; reason: string; confirm: boolean }) => post(`/email/contacts/${id}/status`, v));
  const reverify = useEmailMutation(() => post<{ status: string }>(`/email/contacts/${id}/reverify`));

  if (error) return <p className="text-sm text-red-600">{errorText(error)}</p>;
  if (!data) return <p className="text-sm">Loading…</p>;
  const c = data.contact;
  const needsConfirm = status === 'never' || c.marketingStatus === 'never' || (status === 'all' && c.marketingStatus !== 'all');

  return (
    <div className="space-y-4">
      <Link to="/messaging/contacts" className="text-sm underline">← Contacts</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold">{c.email}</h2>
        <StatusBadge status={c.marketingStatus} />
        <DeliverabilityBadge d={c.deliverability} />
        {c.isTrade && <span className="text-sm">trade</span>}
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="text-base">Consent</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Source: {c.consentSource}</p>
            {(c.lists?.length ?? 0) > 0 && <p>Lists: {c.lists!.join(', ')}</p>}
            <p>Weekly email: {c.digestEnabled ? 'on' : 'off'} · New-product alerts: {c.newProductAlertsEnabled ? 'on' : 'off'}</p>
            <div className="space-y-2 border-t border-[var(--color-border)] pt-2">
              <select aria-label="New status" className={selectClass} value={status} onChange={(e) => setStatus(e.target.value as MarketingStatus)}>
                {(Object.keys(STATUS_LABEL) as MarketingStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
              <Input aria-label="Reason" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button
                size="sm"
                disabled={reason.trim().length < 3 || change.isPending}
                onClick={() => {
                  if (needsConfirm && !confirm(`Set ${c.email} to "${STATUS_LABEL[status]}"? Logged with your reason.`)) return;
                  change.mutate({ status, reason, confirm: needsConfirm }, { onSuccess: () => setReason('') });
                }}
              >
                Change status
              </Button>
              {change.error && <p className="text-red-600">{errorText(change.error)}</p>}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Address</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Bouncer: {c.bouncerResult ?? 'not checked'} {c.bouncerCheckedAt ? `(${fmtDate(c.bouncerCheckedAt)})` : ''}</p>
            <p>Soft bounces: {c.softBounceCount}</p>
            <Button size="sm" variant="outline" onClick={() => reverify.mutate(undefined)} disabled={reverify.isPending}>Re-verify</Button>
            {reverify.data && <p>{JSON.stringify(reverify.data)}</p>}
            {reverify.error && <p className="text-red-600">{errorText(reverify.error)}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Interests and orders</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {Object.entries(data.interests).length === 0 && <p>None yet.</p>}
            {Object.entries(data.interests).map(([k, v]) => <p key={k}>{k}: {v}</p>)}
            <p className="pt-2">{data.orders.count} orders · £{data.orders.totalGbp.toFixed(2)}</p>
            {c.customerId && <Link to="/customers/$id" params={{ id: c.customerId }} className="underline">Customer record</Link>}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Timeline</CardTitle></CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {data.timeline.map((t) => (
              <li key={`${t.type}-${t.id}`} className="border-b border-[var(--color-border)] pb-2 last:border-0">
                <span className="text-[var(--color-muted-foreground)]">{fmtDate(t.at)}</span>{' '}
                <strong>{t.type}</strong>{' '}
                {t.type === 'send' && <>{String(t.detail.kind)} · {String(t.detail.status)} {t.detail.subject ? `· “${String(t.detail.subject)}”` : ''} {t.detail.dropReason ? `· ${String(t.detail.dropReason)}` : ''} {Array.isArray(t.detail.events) && t.detail.events.length ? `· ${(t.detail.events as Array<{ event: string }>).map((e) => e.event).join(', ')}` : ''}</>}
                {t.type === 'consent' && <>{String(t.detail.from ?? 'new')} → {String(t.detail.to)} · {String(t.detail.source)} by {String(t.detail.actor)} {t.detail.reason ? `· ${String(t.detail.reason)}` : ''}</>}
                {t.type === 'order' && <>Order {String(t.detail.orderNumber)} · £{String(t.detail.total)}</>}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
