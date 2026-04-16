import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCSVImport, parseCSVPreview } from '@/features/integrations/use-integrations';
import { useToast } from '@/hooks/use-toast';

export const Route = createFileRoute('/_authed/integrations/csv')({
  component: CSVImportPage,
});

function CSVImportPage() {
  const { toast } = useToast();
  const [csvText, setCsvText] = React.useState('');
  const preview = React.useMemo(() => (csvText ? parseCSVPreview(csvText, 10) : null), [csvText]);
  const importMutation = useCSVImport();

  const handleFile = async (file: File) => {
    const text = await file.text();
    setCsvText(text);
  };

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">CSV order import</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Upload a CSV file to bulk-create orders.
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

      {csvText && (
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setCsvText('')}>
            Clear
          </Button>
          <Button
            disabled={importMutation.isPending}
            onClick={async () => {
              try {
                const result = await importMutation.mutateAsync(csvText);
                toast({
                  title: 'CSV import complete',
                  description: `Imported ${result.imported}, skipped ${result.skipped}`,
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
