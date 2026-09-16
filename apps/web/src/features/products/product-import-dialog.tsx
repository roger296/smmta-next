import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import { useProductImport, type ProductImportResult } from './use-product-import';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Import a product CSV.
 *
 * Deliberately a two-step: choosing a file CHECKS it (a dry run) and shows what
 * would happen; a second, separate press applies it. A bulk write over the whole
 * catalogue is not something to do on one click, and the check costs a second.
 */
export function ProductImportDialog({ open, onOpenChange }: Props) {
  const [csv, setCsv] = React.useState<string | null>(null);
  const [filename, setFilename] = React.useState<string | null>(null);
  const [createCategories, setCreateCategories] = React.useState(false);
  const [checked, setChecked] = React.useState<ProductImportResult | null>(null);
  const [applied, setApplied] = React.useState<ProductImportResult | null>(null);
  const importer = useProductImport();

  function reset() {
    setCsv(null);
    setFilename(null);
    setChecked(null);
    setApplied(null);
    setCreateCategories(false);
    importer.reset();
  }

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    setFilename(file.name);
    setApplied(null);
    const result = await importer.mutateAsync({
      csv: text,
      dryRun: true,
      createMissingCategories: createCategories,
    });
    setChecked(result);
  }

  async function recheck(next: boolean) {
    setCreateCategories(next);
    if (!csv) return;
    setChecked(
      await importer.mutateAsync({ csv, dryRun: true, createMissingCategories: next }),
    );
  }

  async function apply() {
    if (!csv) return;
    const result = await importer.mutateAsync({
      csv,
      dryRun: false,
      createMissingCategories: createCategories,
    });
    setApplied(result);
    setChecked(result);
  }

  const report = applied ?? checked;
  const hasErrors = (report?.errors.length ?? 0) > 0;
  const canApply = Boolean(csv) && report !== null && !hasErrors && !applied;
  const mentionsMissingCategory = report?.errors.some((e) => /does not exist/.test(e.message));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import products</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Use a file in the same format as the Export button produces. Products are matched on{' '}
            <strong>Stock code</strong> — matches are updated, anything else is created. A column
            you delete is left alone; a cell you empty is cleared.
          </p>

          <div className="space-y-1.5">
            <input
              type="file"
              accept=".csv,text/csv"
              aria-label="CSV file"
              onChange={(e) => void onFile(e)}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-[var(--color-border)] file:bg-[var(--color-muted)] file:px-3 file:py-1.5 file:text-sm"
            />
            {filename && (
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Checking <span className="font-medium">{filename}</span>
              </p>
            )}
          </div>

          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={createCategories}
              onCheckedChange={(c) => void recheck(c === true)}
            />
            <span>
              Create item categories that don&rsquo;t exist yet
              <span className="block text-xs text-[var(--color-muted-foreground)]">
                Off by default — an unrecognised category is usually a typo, and a typo that
                silently becomes a real category splits the catalogue.
              </span>
            </span>
          </label>

          {importer.isPending && <p className="text-sm">Checking the file…</p>}

          {importer.isError && (
            <Card>
              <CardContent className="p-4" role="alert">
                <p className="text-sm text-[var(--color-destructive)]">
                  {importer.error instanceof Error ? importer.error.message : 'Import failed'}
                </p>
              </CardContent>
            </Card>
          )}

          {report && !hasErrors && (
            <Card>
              <CardContent className="space-y-2 p-4">
                <p className="text-sm font-medium">
                  {applied
                    ? `Imported — ${report.created} created, ${report.updated} updated.`
                    : `Ready — ${report.created} to create, ${report.updated} to update.`}
                </p>
                {report.createdCategories.length > 0 && (
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    New item categories: {report.createdCategories.join(', ')}
                  </p>
                )}
                {report.ignoredColumns.length > 0 && (
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    Read-only columns ignored: {report.ignoredColumns.join(', ')}
                  </p>
                )}
                {report.unknownColumns.length > 0 && (
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    Columns not recognised: {report.unknownColumns.join(', ')}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {hasErrors && (
            <Card>
              <CardContent className="space-y-2 p-4" role="alert">
                <p className="text-sm font-medium text-[var(--color-destructive)]">
                  {report!.errors.length} row
                  {report!.errors.length === 1 ? '' : 's'} could not be imported, so nothing was
                  written.
                </p>
                {mentionsMissingCategory && !createCategories && (
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    If those categories are genuinely new, tick the box above and the file will be
                    re-checked.
                  </p>
                )}
                <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
                  {report!.errors.slice(0, 50).map((e) => (
                    <li key={`${e.row}-${e.message}`}>
                      <span className="font-medium">Row {e.row}</span>
                      {e.stockCode ? ` (${e.stockCode})` : ''}: {e.message}
                    </li>
                  ))}
                </ul>
                {report!.errors.length > 50 && (
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    …and {report!.errors.length - 50} more.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {applied ? 'Close' : 'Cancel'}
          </Button>
          <Button onClick={() => void apply()} disabled={!canApply || importer.isPending}>
            {importer.isPending && checked ? 'Importing…' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
