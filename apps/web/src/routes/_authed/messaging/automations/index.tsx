import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { patch, useAutomations, useEmailMutation } from '@/features/email/api';
import { errorText } from '@/features/email/ui';

export const Route = createFileRoute('/_authed/messaging/automations/')({ component: AutomationsPage });

const TITLES: Record<string, string> = {
  replenishment: 'Replenishment reminder',
  abandoned_cart: 'Abandoned basket',
  welcome: 'Welcome series',
  post_purchase: 'Post-purchase tips and review',
  winback: 'Win-back',
  preorder: 'Pre-order updates',
  subscription: 'Subscription reminders',
  price_drop: 'Price drop and low stock',
  trade: 'Trade digest',
};

function AutomationsPage() {
  const { data, error } = useAutomations();
  const update = useEmailMutation((v: { key: string; settings: Record<string, unknown> }) => patch(`/email/automations/${v.key}`, v.settings));
  if (error) return <p className="text-sm text-red-600">{errorText(error)}</p>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <p className="text-sm text-[var(--color-muted-foreground)] md:col-span-2">Every automation starts off. Switching one on is a decision: win-back, for instance, can reach many people at once. Discounts stay off unless you allow them here.</p>
      {update.error && <p className="text-sm text-red-600 md:col-span-2">{errorText(update.error)}</p>}
      {data?.map((a) => (
        <Card key={a.key}>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">{TITLES[a.key] ?? a.key}</CardTitle>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" aria-label={`${a.key} enabled`} checked={Boolean(a.enabled)} onChange={(e) => update.mutate({ key: a.key, settings: { enabled: e.target.checked } })} />
              {a.enabled ? 'On' : 'Off'}
            </label>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(a.discount_allowed)} onChange={(e) => update.mutate({ key: a.key, settings: { discount_allowed: e.target.checked } })} /> Discount allowed</label>
            <Input aria-label={`${a.key} discount code`} placeholder="Discount code" defaultValue={String(a.discount_code ?? '')} onBlur={(e) => e.target.value !== a.discount_code && update.mutate({ key: a.key, settings: { discount_code: e.target.value } })} />
            {Object.entries(a).filter(([k, v]) => !['key', 'enabled', 'discount_allowed', 'discount_code', 'last30Days'].includes(k) && (typeof v === 'number' || typeof v === 'string')).map(([k, v]) => (
              <label key={k} className="flex items-center gap-2"><span className="w-40">{k.replace(/_/g, ' ')}</span>
                <Input defaultValue={String(v)} onBlur={(e) => { const val = typeof v === 'number' ? Number(e.target.value) : e.target.value; if (val !== v) update.mutate({ key: a.key, settings: { [k]: val } }); }} />
              </label>
            ))}
            <p className="text-xs text-[var(--color-muted-foreground)]">Last 30 days: {a.last30Days.sent} sent · {a.last30Days.clicked} clicked · {a.last30Days.orders} orders · £{Number(a.last30Days.revenuePer1000).toFixed(2)} per 1,000 sent</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
