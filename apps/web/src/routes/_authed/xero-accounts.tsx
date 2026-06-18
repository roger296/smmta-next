import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import {
  useXeroAccountMap,
  useSaveXeroAccountMap,
  type XeroAccountMapEntry,
} from '@/features/xero/use-xero-account-map';

export const Route = createFileRoute('/_authed/xero-accounts')({
  component: XeroAccountsPage,
});

function XeroAccountsPage() {
  const { data, isLoading } = useXeroAccountMap();
  const save = useSaveXeroAccountMap();
  const { toast } = useToast();
  const [edits, setEdits] = React.useState<Record<string, { code: string; tax: string }>>({});

  const value = (role: string, field: 'code' | 'tax', fallback: string) =>
    edits[role]?.[field] ?? fallback;

  const onChange = (role: string, field: 'code' | 'tax', v: string, other: string) =>
    setEdits((e) => ({
      ...e,
      [role]: {
        code: field === 'code' ? v : (e[role]?.code ?? other),
        tax: field === 'tax' ? v : (e[role]?.tax ?? other),
      },
    }));

  const handleSave = async () => {
    if (!data) return;
    const entries: XeroAccountMapEntry[] = data.map((row) => ({
      role: row.role,
      xeroAccountCode: value(row.role, 'code', row.xeroAccountCode),
      xeroTaxType: value(row.role, 'tax', row.xeroTaxType),
    }));
    try {
      await save.mutateAsync(entries);
      setEdits({});
      toast({ title: 'Xero account map saved' });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Save failed',
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Xero account &amp; tax map</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Map each logical GL role to a Xero account code and tax type. Stock postings, GRNs,
          COGS and wastage use these. Defaults are seeded; remap to your own chart of accounts.
        </p>
      </div>

      {isLoading && (
        <Card>
          <CardContent className="space-y-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      )}

      {!isLoading && data && (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-muted-foreground)]">
                  <th className="px-4 py-3 font-medium">Role</th>
                  <th className="px-4 py-3 font-medium">Xero account code</th>
                  <th className="px-4 py-3 font-medium">Tax type</th>
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr key={row.role} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="px-4 py-3 font-mono text-xs">{row.role}</td>
                    <td className="px-4 py-2">
                      <Input
                        className="h-8 w-32"
                        value={value(row.role, 'code', row.xeroAccountCode)}
                        onChange={(e) =>
                          onChange(row.role, 'code', e.target.value, row.xeroTaxType)
                        }
                      />
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        className="h-8 w-40"
                        value={value(row.role, 'tax', row.xeroTaxType)}
                        onChange={(e) =>
                          onChange(row.role, 'tax', e.target.value, row.xeroAccountCode)
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={save.isPending || Object.keys(edits).length === 0}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
