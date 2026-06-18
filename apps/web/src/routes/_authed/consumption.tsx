import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ChefHat, ClipboardList } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/empty-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatDate, formatMoney } from '@/lib/format';
import { useSites } from '@/features/sites/use-sites';
import {
  useConsumptionList,
  useSessionsAwaiting,
} from '@/features/consumption/use-consumption';

export const Route = createFileRoute('/_authed/consumption')({
  component: ConsumptionDashboard,
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function ConsumptionDashboard() {
  const { data: sites } = useSites();
  const [siteId, setSiteId] = React.useState<string>('');
  const [date, setDate] = React.useState<string>(today());

  React.useEffect(() => {
    if (!siteId && sites && sites.length) setSiteId(sites[0]!.id);
  }, [sites, siteId]);

  const awaiting = useSessionsAwaiting(siteId || undefined, date);
  const records = useConsumptionList(siteId ? { siteId } : undefined);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">End-of-session consumption</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Sessions still awaiting a head-baker consumption record, and recently submitted records
          with their true materials cost.
        </p>
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="w-56 space-y-1.5">
          <Label>Site</Label>
          <Select value={siteId} onValueChange={setSiteId}>
            <SelectTrigger>
              <SelectValue placeholder="Pick a site" />
            </SelectTrigger>
            <SelectContent>
              {(sites ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-44 space-y-1.5">
          <Label>Date</Label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Awaiting a consumption record</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!awaiting.data || awaiting.data.length === 0 ? (
            <div className="p-6">
              <EmptyState
                icon={ClipboardList}
                title="Nothing awaiting"
                description="Either every session for the day has a record, or BumbleBee session polling isn't connected yet."
              />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted-foreground)]">
                  <th className="px-4 py-3 font-medium">Session</th>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Covers</th>
                </tr>
              </thead>
              <tbody>
                {awaiting.data.map((s) => (
                  <tr key={s.sessionId} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="px-4 py-3 font-mono text-xs">{s.sessionId}</td>
                    <td className="px-4 py-3">{formatDate(s.sessionDate)}</td>
                    <td className="px-4 py-3">
                      {s.coverGroups.map((g) => `${g.experience} ×${g.covers}`).join(', ') || '—'}
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
          <CardTitle className="text-base">Recent records</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!records.data || records.data.length === 0 ? (
            <div className="p-6">
              <EmptyState icon={ChefHat} title="No records yet" description="Submitted consumption appears here." />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted-foreground)]">
                  <th className="px-4 py-3 font-medium">Session</th>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Baker</th>
                  <th className="px-4 py-3 font-medium">Materials cost</th>
                  <th className="px-4 py-3 font-medium">Rev.</th>
                </tr>
              </thead>
              <tbody>
                {records.data.map((r) => (
                  <tr key={r.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="px-4 py-3 font-mono text-xs">{r.sessionId}</td>
                    <td className="px-4 py-3">{formatDate(r.sessionDate)}</td>
                    <td className="px-4 py-3">{r.bakerName}</td>
                    <td className="px-4 py-3 tabular-nums">{formatMoney(Number(r.materialsCost))}</td>
                    <td className="px-4 py-3">
                      {r.version > 1 ? <Badge variant="secondary">v{r.version}</Badge> : `v${r.version}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
