/**
 * Settings → Claude connector. Issues and revokes the API keys Claude uses to
 * reach the admin through its MCP server (docs/MCP-CONNECTOR.md). An admin key
 * acts as the person who issues it, with everything they can do here.
 */
import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Copy } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useToast } from '@/hooks/use-toast';

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const CONNECTOR_SCOPES = ['admin:mcp', 'email:mcp', 'email:approve'];

function connectorUrl(): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://admin.cleverdeals.net';
  return `${origin}/api/mcp`;
}

export function ClaudeConnectorPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const keys = useQuery<ApiKeyRow[]>({ queryKey: ['api-keys'], queryFn: () => apiFetch<ApiKeyRow[]>('/admin/api-keys') });
  const [name, setName] = React.useState('Claude');
  const [admin, setAdmin] = React.useState(true);
  const [email, setEmail] = React.useState(true);
  const [approve, setApprove] = React.useState(false);
  const [issued, setIssued] = React.useState<string | null>(null);
  const [revoking, setRevoking] = React.useState<ApiKeyRow | null>(null);

  const create = useMutation({
    mutationFn: () =>
      apiFetch<ApiKeyRow & { key: string }>('/admin/api-keys', {
        method: 'POST',
        body: {
          name: name.trim(),
          scopes: [...(admin ? ['admin:mcp'] : []), ...(email ? ['email:mcp'] : []), ...(approve ? ['email:approve'] : [])],
        },
      }),
    onSuccess: (row) => {
      setIssued(row.key);
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (err) => toast({ variant: 'destructive', title: 'Could not issue the key', description: err instanceof Error ? err.message : '' }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => apiFetch(`/admin/api-keys/${id}/revoke`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  const connectorKeys = (keys.data ?? []).filter((k) => !k.revokedAt && k.scopes.some((s) => CONNECTOR_SCOPES.includes(s)));
  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value);
    toast({ title: 'Copied' });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-6">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-[var(--color-muted-foreground)]" aria-hidden />
            <h3 className="text-base font-medium">Connect Claude</h3>
          </div>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Claude reaches this admin through its MCP server. An admin key acts as you: Claude can do anything you can do
            here, including invoices and credit notes, and every call is logged under your name. Keep the key secret and
            revoke it if it leaks.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="cc-name">Key name</Label>
            <Input id="cc-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <fieldset className="space-y-2 text-sm">
            <legend className="mb-1 font-medium">What Claude may do</legend>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
              The whole admin, as me (orders, products, customers, invoices, stock, purchasing…)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} />
              Messaging tools (draft and schedule campaigns, reports)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} />
              Approve email campaigns (otherwise approval stays with you, in Messaging)
            </label>
          </fieldset>
          <div className="flex justify-end">
            <Button disabled={!name.trim() || (!admin && !email) || create.isPending} onClick={() => create.mutate()}>
              Issue key
            </Button>
          </div>
          {issued && (
            <div className="space-y-3 border border-[var(--color-border)] p-4 text-sm">
              <p className="font-medium">Copy this key now: it is shown only once.</p>
              <div className="flex gap-2">
                <Input readOnly value={issued} className="font-mono text-xs" aria-label="New key" />
                <Button variant="outline" onClick={() => copy(issued)} aria-label="Copy key">
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <p>In Claude, add a custom connector with:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  URL: <code className="font-mono">{connectorUrl()}</code>
                </li>
                <li>
                  Request header <code className="font-mono">Authorization</code> ={' '}
                  <code className="font-mono">Bearer &lt;the key&gt;</code>
                </li>
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-6">
          <h3 className="text-base font-medium">Connector keys</h3>
          {connectorKeys.length === 0 && <p className="text-sm text-[var(--color-muted-foreground)]">No connector keys yet.</p>}
          {connectorKeys.map((k) => (
            <div key={k.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] pb-2 last:border-b-0">
              <div className="space-y-1">
                <div className="text-sm font-medium">
                  {k.name} <span className="font-mono text-xs text-[var(--color-muted-foreground)]">smmta_{k.prefix}_…</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {k.scopes.map((s) => (
                    <Badge key={s} variant="outline">
                      {s}
                    </Badge>
                  ))}
                </div>
                <div className="text-xs text-[var(--color-muted-foreground)]">
                  Last used: {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString('en-GB') : 'never'}
                </div>
              </div>
              <Button variant="outline" onClick={() => setRevoking(k)}>
                Revoke
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke this key?"
        description={`Claude will lose access through "${revoking?.name ?? ''}" at once.`}
        destructive
        confirmLabel="Revoke"
        onConfirm={async () => {
          if (revoking) await revoke.mutateAsync(revoking.id);
          setRevoking(null);
        }}
      />
    </div>
  );
}
