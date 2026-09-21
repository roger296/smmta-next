import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCSVImport, parseCSVPreview, type ImportResult } from '@/features/integrations/use-integrations';
import { useToast } from '@/hooks/use-toast';

export const Route = createFileRoute('/_authed/integrations/csv')({
  component: CSVImportPage,
});

function CSVImportPage() {
  const { toast } = useToast();
  const [csvText, setCsvText] = React.useState('');
  const preview = React.useMemo(() => (csvText ? parseCSVPreview(csvText, 10) : null), [csvText]);
  const importMutation = useCSVImport();
  const [result, setResult] = React.useState<ImportResult | null>(null);

  const handleFile = async (file: File) => {
    const text = await file.text();
    setCsvText(text);
  };

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">CSV order import</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Upload a CSV file to bulk-create orders. One row per order line, grouped by order number.
          Both the native column layout (OrderNumber, SKU, Qty…) and the legacy layout (Order Id,
          Product Code, Quantity, with the address columns “… For Delivery Address” and “… For
          Invoice Address”) are recognised from their headings.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>1. Upload file</CardTitle>
        </CardHeader>
        <CardContent>
          <Input
            type="file"
            accept=".csv,text/csv"
            aria-label="CSV file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </CardContent>
      </Card>

      {preview && preview.rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>2. Preview (first {preview.rows.length} rows)</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                  <tr>
                    {preview.headers.map((h) => (
                      <th key={h} className="px-3 py-2 text-left font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => (
                    <tr
                      key={i}
                      className="border-b border-[var(--color-border)] last:border-b-0"
                    >
                      {preview.headers.map((h) => (
                        <td key={h} className="px-3 py-2">
                          {row[h]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {preview?.error && (
        <p role="alert" className="text-sm text-[var(--color-destructive)]">
          {preview.error}
        </p>
      )}

      {result && (
        <Card>
          <CardHeader>
            <CardTitle>3. Result</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              <span className="font-medium text-green-700">{result.imported} imported</span>
              {' · '}
              <span>{result.skipped} already present</span>
              {' · '}
              <span className="font-medium text-[var(--color-destructive)]">{result.errors.length} failed</span>
            </p>
            {result.orders && result.orders.length > 0 && (
              <ul className="text-xs text-[var(--color-muted-foreground)]">
                {result.orders.map((o) => (
                  <li key={o.orderId}>
                    {o.thirdPartyOrderId} → {o.orderNumber}
                  </li>
                ))}
              </ul>
            )}
            {result.errors.length > 0 && (
              <div>
                <p className="font-medium">Not imported:</p>
                <ul role="list" className="mt-1 text-xs text-[var(--color-destructive)]">
                  {result.errors.map((e, i) => (
                    <li key={i}>
                      {e.thirdPartyOrderId}: {e.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {csvText && (
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setCsvText('')}>
            Clear
          </Button>
          <Button
            disabled={importMutation.isPending}
            onClick={async () => {
              try {
                const outcome = await importMutation.mutateAsync(csvText);
                setResult(outcome);
                toast({
                  title: 'CSV import complete',
                  description: `Imported ${outcome.imported}, skipped ${outcome.skipped}, failed ${outcome.errors.length}`,
                });
                setCsvText('');
              } catch (err) {
                toast({
                  variant: 'destructive',
                  title: 'Import failed',
                  description: err instanceof Error ? err.message : 'Unknown',
                });
              }
            }}
          >
            {importMutation.isPending ? 'Importing…' : 'Import orders'}
          </Button>
        </div>
      )}
    </div>
  );
}
