import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { parseCSVPreview } from '@/features/integrations/use-integrations';
import { useProductsImport, type ProductImportResult } from '@/features/products/use-products';
import { useToast } from '@/hooks/use-toast';

export const Route = createFileRoute('/_authed/products/import')({
  component: ProductImportPage,
});

const COLUMNS: Array<[string, string]> = [
  ['Stock Code (or SKU)', 'required; one product per code'],
  ['Product Name', 'the range; variants sharing it are grouped'],
  ['Fully Qualified Name', "the variant's own name, when it has one"],
  ['ProductGroupId', 'which rows belong together, when the file has it'],
  ['Manufacturer (or Brand)', 'created if unknown'],
  ['Product Description', ''],
  ['Net Weight', 'kg'],
  ['Dimension - H / W / D, Measurement Unit', 'cm, mm or in'],
  ['EAN Code (or Barcode)', 'kept only when it is a real 8 to 14 digit barcode'],
  ['Main Selling Price (or Price)', ''],
  ['Expected Next Cost (or Cost)', ''],
  ['Manufactures Part Number (or MPN)', ''],
  ['Product Type', 'Physical or Service'],
  ['Enter Serial Numbers at Book in, Require Batch Number', 'Yes or No'],
  ['Color', ''],
  ['HS Code', ''],
  ['Seller Integration SKU, Integration SKU 2 to 10', 'marketplace SKUs'],
  ['Image 1 to 5', 'the first is the main image'],
  ['Text Tag 1 to 3', 'classification hints for the range'],
];

function ProductImportPage() {
  const { toast } = useToast();
  const [csvText, setCsvText] = React.useState('');
  const [fileName, setFileName] = React.useState('');
  const [updateExisting, setUpdateExisting] = React.useState(true);
  const [result, setResult] = React.useState<ProductImportResult | null>(null);
  const preview = React.useMemo(() => (csvText ? parseCSVPreview(csvText, 8) : null), [csvText]);
  const rowCount = React.useMemo(
    () => (csvText ? Math.max(0, csvText.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim().length > 0).length - 1) : 0),
    [csvText],
  );
  const importMutation = useProductsImport();

  const handleFile = async (file: File) => {
    setResult(null);
    setFileName(file.name);
    setCsvText(await file.text());
  };

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Import products</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Upload a CSV of products, one row per stock code. The product download from the previous
          system is read as it is; a plainer sheet with SKU, Name, Price and Cost columns works too.
          Existing stock codes are updated unless you untick the box below; a blank cell never clears a
          value a product already has. Stock levels in the file are not imported: book stock in
          through goods received.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1. Choose file</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            type="file"
            accept=".csv,text/csv"
            aria-label="Product CSV file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
          <div className="flex items-center gap-2">
            <Checkbox
              id="update-existing"
              checked={updateExisting}
              onCheckedChange={(v) => setUpdateExisting(v === true)}
            />
            <Label htmlFor="update-existing">Update products whose stock code already exists</Label>
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-[var(--color-muted-foreground)]">Columns recognised</summary>
            <table className="mt-2 text-xs">
              <tbody>
                {COLUMNS.map(([name, note]) => (
                  <tr key={name} className="border-b border-[var(--color-border)] last:border-b-0">
                    <td className="py-1 pr-4 font-medium">{name}</td>
                    <td className="py-1 text-[var(--color-muted-foreground)]">{note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </CardContent>
      </Card>

      {preview?.error && (
        <p role="alert" className="text-sm text-[var(--color-destructive)]">
          {preview.error}
        </p>
      )}

      {preview && preview.rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              2. Preview: {fileName}, {rowCount} rows (first {preview.rows.length} shown)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                  <tr>
                    {preview.headers.map((h) => (
                      <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => (
                    <tr key={i} className="border-b border-[var(--color-border)] last:border-b-0">
                      {preview.headers.map((h) => (
                        <td key={h} className="max-w-xs truncate px-3 py-2" title={row[h]}>
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

      {result && (
        <Card>
          <CardHeader>
            <CardTitle>3. Result</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              <span className="font-medium text-green-700">{result.created} created</span>
              {' · '}
              <span className="font-medium">{result.updated} updated</span>
              {' · '}
              <span>{result.skipped} skipped</span>
              {' · '}
              <span className="font-medium text-[var(--color-destructive)]">{result.failed} failed</span>
              {(result.groupsCreated > 0 || result.manufacturersCreated > 0) && (
                <span className="text-[var(--color-muted-foreground)]">
                  {' · '}
                  {result.groupsCreated} product groups and {result.manufacturersCreated} manufacturers added
                </span>
              )}
            </p>
            {result.problems.length > 0 && (
              <div>
                <p className="font-medium">Rows not imported:</p>
                <ul role="list" className="mt-1 max-h-64 overflow-auto text-xs">
                  {result.problems.map((p, i) => (
                    <li key={i} className={p.kind === 'failed' ? 'text-[var(--color-destructive)]' : 'text-[var(--color-muted-foreground)]'}>
                      Line {p.line}
                      {p.stockCode ? ` (${p.stockCode})` : ''}: {p.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Button asChild variant="outline">
              <Link to="/products">Back to products</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {csvText && (
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setCsvText('');
              setFileName('');
              setResult(null);
            }}
          >
            Clear
          </Button>
          <Button
            disabled={importMutation.isPending}
            onClick={async () => {
              try {
                const outcome = await importMutation.mutateAsync({ csvText, updateExisting });
                setResult(outcome);
                toast({
                  title: 'Product import complete',
                  description: `${outcome.created} created, ${outcome.updated} updated, ${outcome.skipped} skipped, ${outcome.failed} failed`,
                });
              } catch (err) {
                toast({
                  variant: 'destructive',
                  title: 'Import failed',
                  description: err instanceof Error ? err.message : 'Unknown',
                });
              }
            }}
          >
            {importMutation.isPending ? 'Importing…' : `Import ${rowCount} products`}
          </Button>
        </div>
      )}
    </div>
  );
}
