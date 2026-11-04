import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { fmtDate, post, useDeliverability, useEmailMutation } from '@/features/email/api';
import { errorText } from '@/features/email/ui';

export const Route = createFileRoute('/_authed/messaging/deliverability/')({ component: DeliverabilityPage });

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

function DeliverabilityPage() {
  const { data, error } = useDeliverability();
  const [reason, setReason] = useState('');
  const pause = useEmailMutation((r: string) => post('/email/deliverability/pause', { reason: r }));
  const resume = useEmailMutation(() => post('/email/deliverability/resume'));
  const dns = useEmailMutation(() => post('/email/deliverability/dns-check'));
  const ack = useEmailMutation((id: string) => post(`/email/alerts/${id}/ack`));
  if (error) return <p className="text-sm text-red-600">{errorText(error)}</p>;
  if (!data) return <p className="text-sm">Loading…</p>;

  const days = [...new Set((data.daily as Array<{ day: string }>).map((d) => d.day))];
  const series = days.map((day) => {
    const m = (data.daily as Array<Record<string, any>>).find((d) => d.day === day && d.class === 'marketing');
    const t = (data.daily as Array<Record<string, any>>).filter((d) => d.day === day && d.class !== 'marketing');
    const tSent = t.reduce((s, x) => s + x.sent, 0);
    return {
      day,
      'Marketing complaints %': m ? +(m.complaintRate * 100).toFixed(3) : 0,
      'Marketing bounces %': m ? +(m.bounceRate * 100).toFixed(3) : 0,
      'Other bounces %': tSent ? +((t.reduce((s, x) => s + x.bounced, 0) / tSent) * 100).toFixed(3) : 0,
    };
  });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="text-base">Marketing switch</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>{data.marketingPaused ? `Paused: ${data.pausedReason}` : 'Running.'}</p>
            {data.marketingPaused ? (
              <Button onClick={() => resume.mutate(undefined)}>Resume marketing</Button>
            ) : (
              <>
                <Input aria-label="Pause reason" placeholder="Why (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
                <Button variant="destructive" disabled={reason.trim().length < 3} onClick={() => pause.mutate(reason)}>Pause marketing</Button>
              </>
            )}
            <p className="text-xs text-[var(--color-muted-foreground)]">Auto-pause at complaints ≥ {pct(data.thresholds.complaint_rate)} or bounces ≥ {pct(data.thresholds.bounce_rate)} over {data.thresholds.days} days ({data.thresholds.min_sends}+ sends).</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Last 7 days</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {(data.rates7 as Array<Record<string, any>>).map((r) => <p key={r.class}>{r.class}: {r.sent} sent · bounces {pct(r.bounceRate)} · complaints {pct(r.complaintRate)}</p>)}
            {data.rates7.length === 0 && <p>No sends.</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Pipeline</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>Mode: {data.sendMode}{data.sendModeSet ? '' : ' (not set — sender off)'}</p>
            <p>Queued: {data.queued}</p>
            <p>Rate limit: {data.rateLimit.perHour}/hour</p>
            <p>Last send: {fmtDate(data.lastSendAt)}</p>
            <p>Last webhook event: {fmtDate(data.lastWebhookEventAt)}</p>
            <p>Suppression reconciliation: {data.lastReconcile ? `${fmtDate(data.lastReconcile.at)} — ${JSON.stringify(data.lastReconcile.result)}` : 'not run yet'}</p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Bounce and complaint rates, 90 days</CardTitle></CardHeader>
        <CardContent className="h-72">
          {series.length === 0 ? <p className="text-sm">No sends yet.</p> : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="day" fontSize={11} />
                <YAxis fontSize={11} unit="%" />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="Marketing complaints %" stroke="#b91c1c" dot={false} />
                <Line type="monotone" dataKey="Marketing bounces %" stroke="#3B5266" dot={false} />
                <Line type="monotone" dataKey="Other bounces %" stroke="#6B6E76" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between"><CardTitle className="text-base">DNS</CardTitle><Button size="sm" variant="outline" onClick={() => dns.mutate(undefined)}>Check now</Button></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {!data.dns && <p>Not checked yet (daily at 05:50).</p>}
            {data.dns?.checks?.map((c: any) => <p key={c.record}>{c.ok ? '✓' : '✗'} {c.record} — <span className="break-all text-xs">{c.found.join(' | ') || 'not found'}</span></p>)}
            {data.dns && <p className="text-xs text-[var(--color-muted-foreground)]">Checked {fmtDate(data.dns.checkedAt)}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Alerts</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {data.alerts.length === 0 && <p>None.</p>}
            {data.alerts.map((a: any) => (
              <div key={a.id} className="flex items-start justify-between gap-2">
                <p><span className="text-[var(--color-muted-foreground)]">{fmtDate(a.createdAt)}</span> {a.message}</p>
                {!a.acknowledgedAt && <Button size="sm" variant="outline" onClick={() => ack.mutate(a.id)}>Acknowledge</Button>}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
