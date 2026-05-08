import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import {
  type DropshipUpdateInput,
  useDropshipSupplier,
  usePollNow,
  useTestDropshipConnection,
  useUpdateDropshipSupplier,
} from './use-dropship-suppliers';

interface Props {
  supplierId: string;
}

export function DropshipTab({ supplierId }: Props) {
  const { data, isLoading } = useDropshipSupplier(supplierId);
  const updateMutation = useUpdateDropshipSupplier();
  const testMutation = useTestDropshipConnection();
  const pollMutation = usePollNow();
  const { toast } = useToast();
  const [form, setForm] = React.useState<DropshipUpdateInput>({});
  const [apiKeyInput, setApiKeyInput] = React.useState('');
  const [testSku, setTestSku] = React.useState('');
  const [testResult, setTestResult] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (data) {
      const s = data.supplier;
      setForm({
        slug: s.slug ?? '',
        connectorKind: s.connectorKind,
        apiBaseUrl: s.apiBaseUrl ?? '',
        apiAuthScheme: s.apiAuthScheme,
        isDropshipActive: s.isDropshipActive,
        pollIntervalMinutes: s.pollIntervalMinutes,
        dispatchSlaMinDays: s.dispatchSlaMinDays,
        dispatchSlaMaxDays: s.dispatchSlaMaxDays,
        showSupplierNameToCustomers: s.showSupplierNameToCustomers,
      });
      setApiKeyInput('');
    }
  }, [data]);

  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;

  const handleSave = async () => {
    const payload: DropshipUpdateInput = { ...form };
    if (apiKeyInput.trim()) payload.apiKeyPlaintext = apiKeyInput.trim();
    try {
      await updateMutation.mutateAsync({ id: supplierId, input: payload });
      toast({ title: 'Drop-ship config saved' });
      setApiKeyInput('');
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Save failed',
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  };

  const handleTest = async () => {
    if (!testSku.trim()) {
      setTestResult('Enter a SKU first');
      return;
    }
    try {
      const r = await testMutation.mutateAsync({ id: supplierId, supplierSku: testSku.trim() });
      if (!r.ok) setTestResult(`Failed: ${r.error}`);
      else if (r.snapshots && r.snapshots[0]) {
        const s = r.snapshots[0];
        setTestResult(
          `OK · stock ${s.stockQty ?? '—'} · cost ${s.costGbp != null ? `£${s.costGbp.toFixed(2)}` : '—'}`,
        );
      } else setTestResult('OK · no snapshot returned');
    } catch (err) {
      setTestResult(`Failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  };

  const handlePollNow = async () => {
    try {
      const r = await pollMutation.mutateAsync({ id: supplierId });
      const o = r[0];
      if (o?.skippedBecause) toast({ title: `Skipped: ${o.skippedBecause}` });
      else if (o?.errorMessage) toast({ variant: 'destructive', title: 'Poll failed', description: o.errorMessage });
      else toast({ title: `Polled · ${o?.productsUpdated ?? 0}/${o?.productsChecked ?? 0} updated` });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Poll failed',
        description: err instanceof Error ? err.message : 'unknown error',
      });
    }
  };

  const log = data.recentPollLog;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Drop-ship integration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.supplier.lastError && (
            <p
              role="alert"
              className="border border-[var(--color-destructive)] bg-[var(--color-destructive)]/10 p-3 text-sm text-[var(--color-destructive)]"
            >
              Last error: {data.supplier.lastError}
            </p>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="ds-slug">Slug</Label>
              <Input
                id="ds-slug"
                value={form.slug ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                placeholder="e.g. uneek-clothing"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ds-kind">Connector</Label>
              <select
                id="ds-kind"
                value={form.connectorKind ?? 'NONE'}
                onChange={(e) =>
                  setForm((f) => ({ ...f, connectorKind: e.target.value as DropshipUpdateInput['connectorKind'] }))
                }
                className="border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-1.5 text-sm"
              >
                <option value="NONE">None (no integration)</option>
                <option value="UNEEK">Uneek Clothing</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ds-base">API base URL</Label>
              <Input
                id="ds-base"
                value={form.apiBaseUrl ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, apiBaseUrl: e.target.value || null }))}
                placeholder="https://api.uneekclothing.com/"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ds-auth">Auth scheme</Label>
              <Input
                id="ds-auth"
                value={form.apiAuthScheme ?? 'bearer'}
                onChange={(e) => setForm((f) => ({ ...f, apiAuthScheme: e.target.value }))}
              />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="ds-key">
                API key {data.supplier.hasApiKey ? '· (current key hidden — leave blank to keep)' : ''}
              </Label>
              <Input
                id="ds-key"
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder={data.supplier.hasApiKey ? '············' : 'paste new key'}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ds-poll">Poll interval (minutes)</Label>
              <Input
                id="ds-poll"
                type="number"
                min={5}
                max={1440}
                value={form.pollIntervalMinutes ?? 180}
                onChange={(e) =>
                  setForm((f) => ({ ...f, pollIntervalMinutes: Number(e.target.value) }))
                }
              />
            </div>
            <div className="space-y-1">
              <Label>Dispatch SLA (days)</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={365}
                  value={form.dispatchSlaMinDays ?? 2}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, dispatchSlaMinDays: Number(e.target.value) }))
                  }
                  className="w-24"
                  aria-label="Min dispatch days"
                />
                <span>–</span>
                <Input
                  type="number"
                  min={0}
                  max={365}
                  value={form.dispatchSlaMaxDays ?? 5}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, dispatchSlaMaxDays: Number(e.target.value) }))
                  }
                  className="w-24"
                  aria-label="Max dispatch days"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input
                type="checkbox"
                checked={form.isDropshipActive ?? false}
                onChange={(e) => setForm((f) => ({ ...f, isDropshipActive: e.target.checked }))}
              />
              <span>Active (polling worker will include this supplier)</span>
            </label>
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input
                type="checkbox"
                checked={form.showSupplierNameToCustomers ?? false}
                onChange={(e) =>
                  setForm((f) => ({ ...f, showSupplierNameToCustomers: e.target.checked }))
                }
              />
              <span>Show supplier name in customer-facing emails (default: generic "supplier partner")</span>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleSave} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving…' : 'Save changes'}
            </Button>
            <Button variant="outline" onClick={handlePollNow} disabled={pollMutation.isPending}>
              {pollMutation.isPending ? 'Polling…' : 'Poll now'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Test connection</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[200px] space-y-1">
              <Label htmlFor="test-sku">Supplier SKU to look up</Label>
              <Input
                id="test-sku"
                value={testSku}
                onChange={(e) => setTestSku(e.target.value)}
                placeholder="e.g. UC1001"
              />
            </div>
            <Button onClick={handleTest} disabled={testMutation.isPending}>
              {testMutation.isPending ? 'Checking…' : 'Test'}
            </Button>
          </div>
          {testResult && (
            <p className="text-sm font-medium" role="status" aria-live="polite">
              {testResult}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent polls ({log.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {log.length === 0 ? (
            <p className="p-4 text-sm text-[var(--color-muted-foreground)]">
              No polls recorded yet. Click "Poll now" to trigger one.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Started</th>
                  <th className="px-3 py-2 text-left font-medium">Finished</th>
                  <th className="px-3 py-2 text-right font-medium">Checked</th>
                  <th className="px-3 py-2 text-right font-medium">Updated</th>
                  <th className="px-3 py-2 text-left font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {log.map((row) => (
                  <tr key={row.id} className="border-b border-[var(--color-border)] last:border-b-0">
                    <td className="px-3 py-2">{new Date(row.startedAt).toLocaleString()}</td>
                    <td className="px-3 py-2">
                      {row.finishedAt ? new Date(row.finishedAt).toLocaleString() : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">{row.productsChecked}</td>
                    <td className="px-3 py-2 text-right">{row.productsUpdated}</td>
                    <td className="px-3 py-2 text-[var(--color-destructive)]">{row.errorMessage ?? ''}</td>
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
