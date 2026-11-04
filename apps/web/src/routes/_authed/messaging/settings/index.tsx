import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { put, useEmailMutation, useEmailSettings } from '@/features/email/api';
import { errorText } from '@/features/email/ui';

export const Route = createFileRoute('/_authed/messaging/settings/')({ component: SettingsPage });

const HIDDEN = ['automations', 'marketing_paused', 'marketing_paused_reason'];

function SettingsPage() {
  const { data } = useEmailSettings();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = useEmailMutation((patch: Record<string, unknown>) => put('/email/settings', patch));
  useEffect(() => {
    if (data) setDraft(Object.fromEntries(Object.entries(data).filter(([k]) => !HIDDEN.includes(k)).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)])));
  }, [data]);
  if (!data) return <p className="text-sm">Loading…</p>;

  const submit = () => {
    const patch: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(draft)) {
      const orig = data[k];
      let v: unknown = raw;
      if (typeof orig === 'number') v = Number(raw);
      else if (typeof orig === 'boolean') v = raw === 'true';
      else if (typeof orig === 'object') {
        try { v = JSON.parse(raw); } catch { save.reset(); alert(`${k} is not valid JSON`); return; }
      }
      if (JSON.stringify(v) !== JSON.stringify(orig)) patch[k] = v;
    }
    if (Object.keys(patch).length) save.mutate(patch);
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <p className="text-sm text-[var(--color-muted-foreground)]">Each value keeps its shape (numbers stay numbers; times are HH:MM, UK time). The test allowlist and the send mode are set in the server environment, not here. Automations have their own tab.</p>
        {Object.entries(draft).map(([k, v]) => (
          <label key={k} className="grid gap-1 text-sm md:grid-cols-[16rem_1fr]">
            <span className="font-medium">{k.replace(/_/g, ' ')}</span>
            {typeof data[k] === 'object' ? (
              <Textarea aria-label={k} className="font-mono text-xs" rows={Math.min(12, v.split('\n').length)} value={v} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
            ) : (
              <Input aria-label={k} value={v} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
            )}
          </label>
        ))}
        <Button onClick={submit} disabled={save.isPending}>Save settings</Button>
        {save.error && <p className="text-sm text-red-600">{errorText(save.error)}</p>}
        {save.isSuccess && <p className="text-sm">Saved.</p>}
      </CardContent>
    </Card>
  );
}
