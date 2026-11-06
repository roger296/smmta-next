import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { fmtDate, post, useEmailMutation, useImports, useOverview } from '@/features/email/api';
import { Field, selectClass, errorText } from '@/features/email/ui';

export const Route = createFileRoute('/_authed/messaging/imports/')({ component: ImportsPage });

const LIST_TYPES = [
  { v: 'bounces', l: 'Bounces (Suppressions → Bounces)' },
  { v: 'spam_reports', l: 'Spam reports' },
  { v: 'unsubscribes', l: 'Unsubscribes (global + group)' },
  { v: 'contacts', l: 'Marketing contacts' },
];

function ImportsPage() {
  const { data: overview } = useOverview();
  const { data: history } = useImports();
  const [file, setFile] = useState<File | null>(null);
  const [listType, setListType] = useState('bounces');
  const [interests, setInterests] = useState<string[]>([]);
  const [source, setSource] = useState('sendgrid_import');
  const [listName, setListName] = useState('');
  const [report, setReport] = useState<Record<string, any> | null>(null);
  const run = useEmailMutation(async (v: { dryRun: boolean; dryRunId?: string }) => {
    const csvText = await file!.text();
    return post<Record<string, any>>('/email/imports', { csvText, filename: file!.name, listType, defaultInterests: interests, consentSource: source, listName: listType === 'contacts' ? listName.trim() || undefined : undefined, ...v });
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">Import a list</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Order: bounces → spam reports → unsubscribes → contacts, so the safest status wins. Every import is a dry run first; imports never upgrade consent and never touch a “never email” contact.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="CSV file"><input aria-label="CSV file" type="file" accept=".csv,text/csv" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); setReport(null); if (f) setListName(f.name.replace(/\.csv$/i, '').replace(/[_-]+/g, ' ').trim()); }} /></Field>
            <Field label="List type">
              <select aria-label="List type" className={selectClass} value={listType} onChange={(e) => { setListType(e.target.value); setReport(null); }}>
                {LIST_TYPES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
              </select>
            </Field>
            {listType === 'contacts' && (
              <Field label="List name" hint="Every contact in this file is tagged with it, kept for good, and can be chosen when you target a campaign. Leave empty for no tag.">
                <Input aria-label="List name" value={listName} maxLength={60} onChange={(e) => { setListName(e.target.value); setReport(null); }} />
              </Field>
            )}
            <Field label="Consent source" hint="Recorded on each new contact, e.g. sendgrid_import, trade_show_2026."><Input value={source} onChange={(e) => setSource(e.target.value)} /></Field>
            <Field label="Default interests" hint="For rows with no interests or list names of their own.">
              <div className="flex flex-wrap gap-2">
                {overview?.materials.map((m) => (
                  <label key={m.key} className="flex items-center gap-1 text-sm">
                    <input type="checkbox" checked={interests.includes(m.key)} onChange={(e) => setInterests((s) => (e.target.checked ? [...s, m.key] : s.filter((x) => x !== m.key)))} /> {m.name}
                  </label>
                ))}
              </div>
            </Field>
          </div>
          <div className="flex gap-2">
            <Button disabled={!file || run.isPending} onClick={() => run.mutate({ dryRun: true }, { onSuccess: (r) => setReport(r) })}>Dry run</Button>
            <Button
              variant="destructive"
              disabled={!report?.dryRun || run.isPending}
              onClick={() => confirm(`Run this import live? ${report?.would_create} new, ${report?.would_update} updated.`) && run.mutate({ dryRun: false, dryRunId: report!.importId }, { onSuccess: (r) => setReport(r) })}
            >
              Run live
            </Button>
          </div>
          {run.error && <p className="text-sm text-red-600">{errorText(run.error)}</p>}
          {report && (
            <div data-testid="import-report" className="rounded-md border border-[var(--color-border)] p-3 text-sm">
              <p className="font-medium">{report.dryRun ? 'Dry run' : report.already_imported ? 'Already imported — nothing changed' : 'Imported'}: {report.filename}{report.list ? ` → list “${report.list}”` : ''}</p>
              <div className="mt-2 grid grid-cols-2 gap-1 md:grid-cols-4">
                {['rows_read', 'valid', 'invalid_syntax', 'duplicates_in_file', 'already_present', 'would_create', 'would_update', 'would_tag', 'would_downgrade', 'would_upgrade_refused', 'linked_customers', 'created', 'updated', 'skipped'].filter((k) => report[k] !== undefined).map((k) => (
                  <span key={k}>{k.replace(/_/g, ' ')}: <strong>{report[k]}</strong></span>
                ))}
              </div>
              {report.conflicts?.length > 0 && (
                <ul className="mt-2 list-disc pl-5">
                  {report.conflicts.map((c: any) => <li key={`${c.row}-${c.email}`}>row {c.row}: {c.email} — {c.kind.replace(/_/g, ' ')} ({c.from} → {c.to})</li>)}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">History</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-[var(--color-border)] text-left"><th className="px-3 py-2">When</th><th className="px-3 py-2">File</th><th className="px-3 py-2">List</th><th className="px-3 py-2">Run</th><th className="px-3 py-2">Rows</th><th className="px-3 py-2">Created / updated</th><th className="px-3 py-2">By</th></tr></thead>
            <tbody>
              {history?.map((h) => (
                <tr key={h.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="px-3 py-2">{fmtDate(h.createdAt)}</td><td className="px-3 py-2">{h.filename}</td><td className="px-3 py-2">{h.listType}</td>
                  <td className="px-3 py-2">{h.dryRun ? 'dry run' : 'live'}</td><td className="px-3 py-2">{h.rowCount}</td><td className="px-3 py-2">{h.created} / {h.updated}</td><td className="px-3 py-2">{h.createdBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
