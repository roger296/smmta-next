import { useEffect, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useDebounce } from '@/hooks/use-debounce';
import {
  fmtDate,
  patch,
  post,
  useCampaign,
  useCampaignPreview,
  useEmailMutation,
  useOverview,
  type Block,
  type Campaign,
} from '@/features/email/api';
import { CampaignBadge, Field, selectClass, errorText } from '@/features/email/ui';
import { useQuery } from '@tanstack/react-query';

export const Route = createFileRoute('/_authed/messaging/campaigns/$id')({ component: CampaignPage });

interface Seg {
  status?: string;
  interests_any?: string[];
  lists_any?: string[];
  is_trade?: boolean;
  last_order_within_days?: number;
  last_order_older_than_days?: number;
  engaged_within_days?: number;
}

const BLOCK_TEMPLATES: Record<string, Block> = {
  Text: { type: 'Text', props: { body: '' } },
  Hero: { type: 'Hero', props: { heading: '', body: '', ctaUrl: '', ctaLabel: 'Shop now' } },
  FeaturedText: { type: 'FeaturedText', props: { heading: '', markdown: '' } },
  DealsList: { type: 'DealsList', props: { deals: [{ title: '', description: '', url: '' }] } },
};

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function BlockEditor({ block, onChange, onRemove }: { block: Block; onChange: (b: Block) => void; onRemove: () => void }) {
  const set = (k: string, v: unknown) => onChange({ ...block, props: { ...block.props, [k]: v } });
  return (
    <div className="space-y-2 rounded-md border border-[var(--color-border)] p-3">
      <div className="flex items-center justify-between text-sm font-medium">
        {block.type}
        <Button size="sm" variant="ghost" onClick={onRemove}>Remove</Button>
      </div>
      {block.type === 'Text' && <Textarea aria-label="Text" value={String(block.props.body ?? '')} onChange={(e) => set('body', e.target.value)} />}
      {block.type === 'Hero' && (
        <>
          <Input aria-label="Heading" placeholder="Heading" value={String(block.props.heading ?? '')} onChange={(e) => set('heading', e.target.value)} />
          <Textarea aria-label="Body" placeholder="Body" value={String(block.props.body ?? '')} onChange={(e) => set('body', e.target.value)} />
          <Input aria-label="Button link" placeholder="https://… (shop link)" value={String(block.props.ctaUrl ?? '')} onChange={(e) => set('ctaUrl', e.target.value)} />
          <Input aria-label="Button label" value={String(block.props.ctaLabel ?? '')} onChange={(e) => set('ctaLabel', e.target.value)} />
        </>
      )}
      {block.type === 'FeaturedText' && (
        <>
          <Input aria-label="Heading" placeholder="Heading" value={String(block.props.heading ?? '')} onChange={(e) => set('heading', e.target.value)} />
          <Textarea aria-label="Markdown" placeholder="Markdown" value={String(block.props.markdown ?? '')} onChange={(e) => set('markdown', e.target.value)} />
        </>
      )}
      {!['Text', 'Hero', 'FeaturedText'].includes(block.type) && (
        <Textarea
          aria-label="Block JSON"
          className="font-mono text-xs"
          defaultValue={JSON.stringify(block.props, null, 2)}
          onBlur={(e) => {
            try {
              onChange({ ...block, props: JSON.parse(e.target.value) });
            } catch {
              /* keep the last good value */
            }
          }}
        />
      )}
    </div>
  );
}

function CampaignPage() {
  const { id } = Route.useParams();
  const { data, error } = useCampaign(id);
  const { data: overview } = useOverview();
  const [form, setForm] = useState<Partial<Campaign> & { subjectB?: string; abOn?: boolean }>({});
  const [seg, setSeg] = useState<Seg>({});
  const [showPreview, setShowPreview] = useState(false);
  const [tab, setTab] = useState(0);
  const [testTo, setTestTo] = useState('');

  useEffect(() => {
    if (!data) return;
    setForm({ ...data.campaign, subjectB: data.variant?.subject ?? '', abOn: Boolean(data.variant && data.variant.status !== 'cancelled') });
    setSeg(data.campaign.segment as Seg);
  }, [data]);

  const debouncedSeg = useDebounce(seg, 400);
  const count = useQuery({
    queryKey: ['email', 'segment-count', debouncedSeg, data?.campaign.class, data?.campaign.kind],
    queryFn: () => post<{ count: number }>('/email/segments/preview', { segment: debouncedSeg, class: data!.campaign.class, kind: data!.campaign.kind }),
    enabled: Boolean(data),
  });
  const preview = useCampaignPreview(id, showPreview);

  const save = useEmailMutation(() =>
    patch<Campaign>(`/email/campaigns/${id}`, {
      name: form.name,
      subject: form.subject,
      preheader: form.preheader ?? null,
      segment: seg,
      content: form.content,
      scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : null,
      sendWindowMinutes: Number(form.sendWindowMinutes ?? 0),
      subjectB: form.abOn ? form.subjectB : '',
    }),
  );
  const action = useEmailMutation((v: { path: string; body?: unknown }) => post<Campaign>(`/email/campaigns/${id}/${v.path}`, v.body ?? {}));

  if (error) return <p className="text-sm text-red-600">{errorText(error)}</p>;
  if (!data) return <p className="text-sm">Loading…</p>;
  const c = data.campaign;
  const editable = ['draft', 'pending_approval', 'scheduled'].includes(c.status);
  const content = (form.content ?? []) as Block[];
  const setContent = (b: Block[]) => setForm((f) => ({ ...f, content: b }));
  const r = data.report;

  return (
    <div className="space-y-4">
      <Link to="/messaging/campaigns" className="text-sm underline">← Campaigns</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold">{c.name}</h2>
        <CampaignBadge status={c.status} />
        <span className="text-sm text-[var(--color-muted-foreground)]">{c.kind.replace('_', ' ')} · {c.class} · by {c.createdBy}{c.approvedBy ? ` · approved by ${c.approvedBy}` : ''}</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Message</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Field label="Name"><Input value={form.name ?? ''} disabled={!editable} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Subject" hint="{{first_name|there}} puts in a first name, with a fallback."><Input aria-label="Subject" value={form.subject ?? ''} disabled={!editable} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>
            <Field label="Preheader"><Input value={form.preheader ?? ''} disabled={!editable} onChange={(e) => setForm({ ...form, preheader: e.target.value })} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(form.abOn)} disabled={!editable} onChange={(e) => setForm({ ...form, abOn: e.target.checked })} /> A/B test a second subject (needs 200+ contacts)</label>
            {form.abOn && <Field label="Subject B"><Input aria-label="Subject B" value={form.subjectB ?? ''} disabled={!editable} onChange={(e) => setForm({ ...form, subjectB: e.target.value })} /></Field>}
            <div className="space-y-2">
              <p className="text-sm font-medium">Content</p>
              {content.map((b, i) => (
                <BlockEditor key={i} block={b} onChange={(nb) => setContent(content.map((x, j) => (j === i ? nb : x)))} onRemove={() => setContent(content.filter((_, j) => j !== i))} />
              ))}
              {editable && (
                <div className="flex flex-wrap gap-2">
                  {Object.keys(BLOCK_TEMPLATES).map((t) => (
                    <Button key={t} size="sm" variant="outline" onClick={() => setContent([...content, structuredClone(BLOCK_TEMPLATES[t]!)])}>+ {t}</Button>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Audience and schedule</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Field label="Consent">
              <select aria-label="Segment status" className={selectClass} value={seg.status ?? ''} disabled={!editable} onChange={(e) => setSeg({ ...seg, status: e.target.value || undefined })}>
                <option value="">Anyone the gate allows</option>
                <option value="all">Accepts all</option>
                <option value="transactional_only">Transactional only</option>
              </select>
            </Field>
            <Field label="Interested in any of">
              <div className="flex flex-wrap gap-2">
                {overview?.materials.map((m) => (
                  <label key={m.key} className="flex items-center gap-1 text-sm">
                    <input type="checkbox" disabled={!editable} checked={(seg.interests_any ?? []).includes(m.key)} onChange={(e) => { const cur = seg.interests_any ?? []; const next = e.target.checked ? [...cur, m.key] : cur.filter((k) => k !== m.key); setSeg({ ...seg, interests_any: next.length ? next : undefined }); }} /> {m.name}
                  </label>
                ))}
              </div>
            </Field>
            {(overview?.lists?.length ?? 0) > 0 && (
              <Field label="On any of these lists">
                <div className="flex flex-wrap gap-2">
                  {overview!.lists.map((l) => (
                    <label key={l.name} className="flex items-center gap-1 text-sm">
                      <input type="checkbox" disabled={!editable} checked={(seg.lists_any ?? []).includes(l.name)} onChange={(e) => { const cur = seg.lists_any ?? []; const next = e.target.checked ? [...cur, l.name] : cur.filter((k) => k !== l.name); setSeg({ ...seg, lists_any: next.length ? next : undefined }); }} /> {l.name} <span className="text-[var(--color-muted-foreground)]">({l.contacts})</span>
                    </label>
                  ))}
                </div>
              </Field>
            )}
            <Field label="Trade">
              <select aria-label="Segment trade" className={selectClass} value={seg.is_trade === undefined ? '' : String(seg.is_trade)} disabled={!editable} onChange={(e) => setSeg({ ...seg, is_trade: e.target.value === '' ? undefined : e.target.value === 'true' })}>
                <option value="">Trade and retail</option><option value="true">Trade only</option><option value="false">Retail only</option>
              </select>
            </Field>
            <div className="grid grid-cols-3 gap-2">
              {(['last_order_within_days', 'last_order_older_than_days', 'engaged_within_days'] as const).map((k) => (
                <Field key={k} label={k.replace(/_/g, ' ')}>
                  <Input type="number" min={1} disabled={!editable} value={seg[k] ?? ''} onChange={(e) => setSeg({ ...seg, [k]: e.target.value ? Number(e.target.value) : undefined })} />
                </Field>
              ))}
            </div>
            <p data-testid="segment-count" className="text-sm">{count.isFetching ? 'Counting…' : count.data ? `${count.data.count} contacts after consent, deliverability and the marketing gap.` : ''}</p>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Send at"><Input type="datetime-local" disabled={!editable} value={toLocalInput(form.scheduledAt ?? null)} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value ? new Date(e.target.value).toISOString() : null })} /></Field>
              <Field label="Spread over (minutes)"><Input type="number" min={0} max={1440} disabled={!editable} value={form.sendWindowMinutes ?? 0} onChange={(e) => setForm({ ...form, sendWindowMinutes: Number(e.target.value) })} /></Field>
            </div>
            <div className="flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-3">
              {editable && <Button variant="outline" onClick={() => save.mutate(undefined)} disabled={save.isPending}>Save draft</Button>}
              {c.status === 'draft' && <Button onClick={() => save.mutate(undefined, { onSuccess: () => action.mutate({ path: 'schedule' }) })}>Schedule</Button>}
              {c.status === 'pending_approval' && <Button onClick={() => confirm(`Approve sending to ${c.audienceCount} contacts?`) && action.mutate({ path: 'approve' })}>Approve</Button>}
              {c.status === 'sending' && <Button variant="outline" onClick={() => action.mutate({ path: 'pause' })}>Pause</Button>}
              {c.status === 'paused' && <Button variant="outline" onClick={() => action.mutate({ path: 'resume' })}>Resume</Button>}
              {!['sent', 'cancelled'].includes(c.status) && <Button variant="destructive" onClick={() => confirm('Cancel this campaign?') && action.mutate({ path: 'cancel' })}>Cancel campaign</Button>}
            </div>
            {(save.error || action.error) && <p className="text-sm text-red-600">{errorText(save.error ?? action.error)}</p>}
            {save.isSuccess && !save.error && <p className="text-sm">Saved.</p>}
            <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
              <Input aria-label="Test address" placeholder="Test address (allowlist only)" value={testTo} onChange={(e) => setTestTo(e.target.value)} className="w-64" />
              <Button size="sm" variant="outline" disabled={!testTo} onClick={() => action.mutate({ path: 'test-send', body: { emails: [testTo] } })}>Send test</Button>
              <span className="text-xs text-[var(--color-muted-foreground)]">Mode: {overview?.sendMode}{overview?.sendMode === 'sandbox' ? ' — SendGrid delivers nothing' : ''}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between"><CardTitle className="text-base">Preview</CardTitle><Button size="sm" variant="outline" onClick={() => { setShowPreview(true); void preview.refetch(); }}>{showPreview ? 'Refresh preview' : 'Show preview'}</Button></CardHeader>
        {showPreview && (
          <CardContent className="space-y-2">
            <p className="text-xs text-[var(--color-muted-foreground)]">Save the draft first to preview your latest changes.</p>
            <div className="flex gap-2">
              {preview.data?.map((p, i) => <Button key={p.label} size="sm" variant={tab === i ? 'default' : 'outline'} onClick={() => setTab(i)}>{p.label}</Button>)}
            </div>
            {preview.data?.[tab] && (
              <>
                <p className="text-sm"><strong>Subject:</strong> {preview.data[tab]!.subject}</p>
                <iframe title="Email preview" className="h-[640px] w-full border border-[var(--color-border)] bg-white" srcDoc={preview.data[tab]!.html} sandbox="" />
              </>
            )}
            {preview.error && <p className="text-sm text-red-600">{errorText(preview.error)}</p>}
          </CardContent>
        )}
      </Card>

      {['sending', 'paused', 'sent'].includes(c.status) && (
        <Card>
          <CardHeader><CardTitle className="text-base">Report</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
              {([['Sent', r.sent], ['Delivered', r.delivered], ['Clicked', r.clicked], ['Orders', r.orders], ['Revenue (ex VAT)', `£${r.revenueExVat.toFixed(2)}`], ['Per 1,000 sent', `£${r.revenuePer1000.toFixed(2)}`], ['Opened', r.opened], ['Bounced', r.bounced], ['Unsubscribed', r.unsubscribesAfter], ['Complaints', r.complained]] as const).map(([l, v]) => (
                <div key={l} className="rounded-md border border-[var(--color-border)] p-2"><p className="text-xs text-[var(--color-muted-foreground)]">{l}</p><p className="text-lg font-semibold">{v}</p></div>
              ))}
            </div>
            {Object.keys(r.droppedByReason).length > 0 && <p>Dropped: {Object.entries(r.droppedByReason).map(([k, v]) => `${k} ${v}`).join(', ')}</p>}
            {r.ab.length > 0 && <p>A/B: {r.ab.map((a) => `${a.variant}: ${a.clicked}/${a.sent} clicked (${(a.clickRate * 100).toFixed(1)}%)`).join(' · ')}{c.abWinner ? ` — winner ${c.abWinner}` : ''}</p>}
            {r.links.length > 0 && (
              <table className="w-full"><thead><tr className="text-left"><th>Link</th><th>Clicks</th></tr></thead><tbody>{r.links.map((l) => <tr key={l.url}><td className="break-all pr-2">{l.url}</td><td>{l.clicks}</td></tr>)}</tbody></table>
            )}
            <p className="text-xs text-[var(--color-muted-foreground)]">Last sends: {data.sends.slice(0, 10).map((s) => `${s.email} ${s.status}`).join(' · ')} · scheduled {fmtDate(c.scheduledAt)}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
