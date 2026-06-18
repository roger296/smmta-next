import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatMoney } from '@/lib/format';
import { useSites } from '@/features/sites/use-sites';
import {
  useConsumptionVariance,
  useWastageReport,
  useFoodCost,
  useExpiryReport,
} from '@/features/reports/use-reports';

export const Route = createFileRoute('/_authed/reports')({
  component: ReportsPage,
});

function monthStart(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function ReportsPage() {
  const { data: sites } = useSites();
  const [from, setFrom] = React.useState(monthStart());
  const [to, setTo] = React.useState(todayStr());
  const [siteId, setSiteId] = React.useState<string>('ALL');

  const period = { from, to, siteId: siteId === 'ALL' ? undefined : siteId };
  const variance = useConsumptionVariance(period);
  const wastage = useWastageReport(period);
  const foodCost = useFoodCost(period);
  const expiry = useExpiryReport(to, { siteId: siteId === 'ALL' ? undefined : siteId });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Where the recipe (expected), the head-baker form (actual) and the stock-take (counted)
          disagree — portion drift, wastage and shrinkage, worst-first.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="w-40 space-y-1.5">
          <Label>From</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="w-40 space-y-1.5">
          <Label>To</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="w-56 space-y-1.5">
          <Label>Site</Label>
          <Select value={siteId} onValueChange={setSiteId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All sites</SelectItem>
              {(sites ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Tabs defaultValue="variance">
        <TabsList>
          <TabsTrigger value="variance">Portion variance</TabsTrigger>
          <TabsTrigger value="wastage">Wastage</TabsTrigger>
          <TabsTrigger value="food-cost">Food cost</TabsTrigger>
          <TabsTrigger value="expiry">Expiry</TabsTrigger>
        </TabsList>

        <TabsContent value="variance">
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted-foreground)]">
                    <th className="px-4 py-3 font-medium">Product</th>
                    <th className="px-4 py-3 font-medium">Site</th>
                    <th className="px-4 py-3 font-medium">Expected</th>
                    <th className="px-4 py-3 font-medium">Actual</th>
                    <th className="px-4 py-3 font-medium">Drift</th>
                    <th className="px-4 py-3 font-medium">£ variance</th>
                    <th className="px-4 py-3 font-medium">Shrinkage</th>
                  </tr>
                </thead>
                <tbody>
                  {(variance.data ?? []).map((r) => (
                    <tr key={`${r.siteId}-${r.productId}`} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="px-4 py-3">{r.productName}</td>
                      <td className="px-4 py-3">{r.siteName}</td>
                      <td className="px-4 py-3 tabular-nums">{r.expectedQty} {r.stockUom}</td>
                      <td className="px-4 py-3 tabular-nums">{r.actualQty} {r.stockUom}</td>
                      <td className="px-4 py-3 tabular-nums">
                        {r.variancePct != null ? `${r.variancePct}%` : '—'}
                      </td>
                      <td className="px-4 py-3 tabular-nums">{formatMoney(r.varianceCost)}</td>
                      <td className="px-4 py-3 tabular-nums">
                        {r.shrinkageQty} {r.stockUom}
                      </td>
                    </tr>
                  ))}
                  {variance.data?.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-6 text-center text-[var(--color-muted-foreground)]">
                        No consumption in this period.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="wastage">
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted-foreground)]">
                    <th className="px-4 py-3 font-medium">Product</th>
                    <th className="px-4 py-3 font-medium">Site</th>
                    <th className="px-4 py-3 font-medium">Wasted</th>
                    <th className="px-4 py-3 font-medium">£ cost</th>
                    <th className="px-4 py-3 font-medium">Times</th>
                    <th className="px-4 py-3 font-medium">Reasons</th>
                  </tr>
                </thead>
                <tbody>
                  {(wastage.data ?? []).map((r) => (
                    <tr key={`${r.siteId}-${r.productId}`} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="px-4 py-3">{r.productName}</td>
                      <td className="px-4 py-3">{r.siteName}</td>
                      <td className="px-4 py-3 tabular-nums">{r.wastageQty} {r.stockUom}</td>
                      <td className="px-4 py-3 tabular-nums">{formatMoney(r.wastageCost)}</td>
                      <td className="px-4 py-3 tabular-nums">{r.occurrences}</td>
                      <td className="px-4 py-3">
                        {r.reasons.map((reason) => (
                          <Badge key={reason} variant="secondary" className="mr-1">
                            {reason}
                          </Badge>
                        ))}
                      </td>
                    </tr>
                  ))}
                  {wastage.data?.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-[var(--color-muted-foreground)]">
                        No wastage recorded in this period.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="food-cost">
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted-foreground)]">
                    <th className="px-4 py-3 font-medium">Site</th>
                    <th className="px-4 py-3 font-medium">Covers</th>
                    <th className="px-4 py-3 font-medium">Materials cost</th>
                    <th className="px-4 py-3 font-medium">Cost / cover</th>
                    <th className="px-4 py-3 font-medium">Wastage cost</th>
                  </tr>
                </thead>
                <tbody>
                  {(foodCost.data ?? []).map((r) => (
                    <tr key={r.siteId} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="px-4 py-3">{r.siteName}</td>
                      <td className="px-4 py-3 tabular-nums">{r.covers}</td>
                      <td className="px-4 py-3 tabular-nums">{formatMoney(r.actualCost)}</td>
                      <td className="px-4 py-3 tabular-nums">
                        {r.costPerCover != null ? formatMoney(r.costPerCover) : '—'}
                      </td>
                      <td className="px-4 py-3 tabular-nums">{formatMoney(r.wastageCost)}</td>
                    </tr>
                  ))}
                  {foodCost.data?.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-[var(--color-muted-foreground)]">
                        No consumption in this period.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="expiry">
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted-foreground)]">
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Product</th>
                    <th className="px-4 py-3 font-medium">Batch</th>
                    <th className="px-4 py-3 font-medium">Use by</th>
                    <th className="px-4 py-3 font-medium">Remaining</th>
                  </tr>
                </thead>
                <tbody>
                  {(expiry.data?.expired ?? []).map((b) => (
                    <tr key={b.batchId} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="px-4 py-3"><Badge variant="destructive">Expired</Badge></td>
                      <td className="px-4 py-3">{b.productName}</td>
                      <td className="px-4 py-3 font-mono text-xs">{b.batchCode}</td>
                      <td className="px-4 py-3">{b.useBy ?? '—'}</td>
                      <td className="px-4 py-3 tabular-nums">{b.qtyRemaining} {b.stockUom}</td>
                    </tr>
                  ))}
                  {(expiry.data?.expiringSoon ?? []).map((b) => (
                    <tr key={b.batchId} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="px-4 py-3"><Badge variant="secondary">Soon</Badge></td>
                      <td className="px-4 py-3">{b.productName}</td>
                      <td className="px-4 py-3 font-mono text-xs">{b.batchCode}</td>
                      <td className="px-4 py-3">{b.useBy ?? '—'}</td>
                      <td className="px-4 py-3 tabular-nums">{b.qtyRemaining} {b.stockUom}</td>
                    </tr>
                  ))}
                  {expiry.data && expiry.data.expired.length === 0 && expiry.data.expiringSoon.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-[var(--color-muted-foreground)]">
                        No batches expired or expiring by {to}.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
