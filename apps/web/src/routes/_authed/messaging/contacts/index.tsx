import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { API_BASE_URL } from '@/lib/api-client';
import { getToken } from '@/lib/auth';
import { useContacts, useOverview, fmtDate, post, useEmailMutation } from '@/features/email/api';
import { DeliverabilityBadge, StatusBadge, selectClass, errorText } from '@/features/email/ui';
import { useDebounce } from '@/hooks/use-debounce';

export const Route = createFileRoute('/_authed/messaging/contacts/')({ component: ContactsPage });

function ContactsPage() {
  const { data: overview } = useOverview();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [deliverability, setDeliverability] = useState('');
  const [interest, setInterest] = useState('');
  const [trade, setTrade] = useState('');
  const [source, setSource] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkStatus, setBulkStatus] = useState('transactional_only');
  const [bulkReason, setBulkReason] = useState('');
  const q = { search: useDebounce(search, 300) || undefined, status: status || undefined, deliverability: deliverability || undefined, interest: interest || undefined, is_trade: trade || undefined, source: source || undefined, page, page_size: 50 };
  const { data, isLoading, error } = useContacts(q);
  const bulk = useEmailMutation((v: { ids: string[]; status: string; reason: string; confirm: boolean }) => post<{ changed: number; refused: number }>('/email/contacts/bulk-status', v));

  const exportCsv = async () => {
    const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    const res = await fetch(`${API_BASE_URL}/email/contacts/export.csv?${params}`, { headers: { Authorization: `Bearer ${getToken()}` } });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'email-contacts.csv';
    a.click();
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        <Input placeholder="Search address" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="md:col-span-2" />
        <select aria-label="Status" className={selectClass} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          <option value="all">Accepts all</option>
          <option value="transactional_only">Transactional only</option>
          <option value="never">Never email</option>
        </select>
        <select aria-label="Deliverability" className={selectClass} value={deliverability} onChange={(e) => setDeliverability(e.target.value)}>
          <option value="">Any deliverability</option>
          {['ok', 'soft_bounce', 'hard_bounce', 'complained', 'invalid'].map((d) => <option key={d} value={d}>{d.replace('_', ' ')}</option>)}
        </select>
        <select aria-label="Interest" className={selectClass} value={interest} onChange={(e) => setInterest(e.target.value)}>
          <option value="">Any interest</option>
          {overview?.materials.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
        </select>
        <select aria-label="Trade" className={selectClass} value={trade} onChange={(e) => setTrade(e.target.value)}>
          <option value="">Trade and retail</option>
          <option value="true">Trade only</option>
          <option value="false">Retail only</option>
        </select>
        <Input placeholder="Consent source" value={source} onChange={(e) => setSource(e.target.value)} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>{data ? `${data.total} contacts` : ''}</span>
        <Button variant="outline" size="sm" onClick={exportCsv}>Export CSV</Button>
        {selected.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span>{selected.length} selected →</span>
            <select aria-label="Bulk status" className={selectClass + ' w-48'} value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
              <option value="transactional_only">Transactional only</option>
              <option value="never">Never email</option>
              <option value="all">Accepts all</option>
            </select>
            <Input placeholder="Reason (required)" value={bulkReason} onChange={(e) => setBulkReason(e.target.value)} className="w-64" />
            <Button
              size="sm"
              disabled={bulkReason.trim().length < 3 || bulk.isPending}
              onClick={() => {
                if (bulkStatus !== 'transactional_only' && !confirm(`Set ${selected.length} contacts to "${bulkStatus}"? This is logged with your reason.`)) return;
                bulk.mutate({ ids: selected, status: bulkStatus, reason: bulkReason, confirm: true }, { onSuccess: () => setSelected([]) });
              }}
            >
              Change status
            </Button>
            {bulk.data && <span>{bulk.data.changed} changed, {bulk.data.refused} refused</span>}
            {bulk.error && <span className="text-red-600">{errorText(bulk.error)}</span>}
          </div>
        )}
      </div>
      <Card>
        <CardContent className="overflow-x-auto p-0">
          {error ? <p className="p-4 text-sm text-red-600">{errorText(error)}</p> : null}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left">
                <th className="px-3 py-2"><input type="checkbox" aria-label="Select all" checked={!!data && data.contacts.length > 0 && selected.length === data.contacts.length} onChange={(e) => setSelected(e.target.checked ? (data?.contacts.map((c) => c.id) ?? []) : [])} /></th>
                <th className="px-3 py-2">Address</th>
                <th className="px-3 py-2">Consent</th>
                <th className="px-3 py-2">Deliverability</th>
                <th className="px-3 py-2">Interests</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Last order</th>
                <th className="px-3 py-2">Last click</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td className="px-3 py-4" colSpan={8}>Loading…</td></tr>}
              {data?.contacts.map((c) => (
                <tr key={c.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="px-3 py-2"><input type="checkbox" aria-label={`Select ${c.email}`} checked={selected.includes(c.id)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, c.id] : s.filter((x) => x !== c.id)))} /></td>
                  <td className="px-3 py-2"><Link to="/messaging/contacts/$id" params={{ id: c.id }} className="underline">{c.email}</Link>{c.isTrade ? ' · trade' : ''}</td>
                  <td className="px-3 py-2"><StatusBadge status={c.marketingStatus} /></td>
                  <td className="px-3 py-2"><DeliverabilityBadge d={c.deliverability} /></td>
                  <td className="px-3 py-2">{c.interests.map((k) => k.split(':')[1]).join(', ') || '—'}</td>
                  <td className="px-3 py-2">{c.consentSource}</td>
                  <td className="px-3 py-2">{fmtDate(c.lastOrderAt)}</td>
                  <td className="px-3 py-2">{fmtDate(c.lastClickAt)}</td>
                </tr>
              ))}
              {data && data.contacts.length === 0 && <tr><td className="px-3 py-4 text-[var(--color-muted-foreground)]" colSpan={8}>No contacts match.</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
      {data && data.total > data.pageSize && (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-sm">Page {page} of {Math.ceil(data.total / data.pageSize)}</span>
          <Button variant="outline" size="sm" disabled={page * data.pageSize >= data.total} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}
