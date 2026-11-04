import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-client';
import { useTemplates } from '@/features/email/api';

export const Route = createFileRoute('/_authed/messaging/templates/')({ component: TemplatesPage });

function TemplatesPage() {
  const { data } = useTemplates();
  const [key, setKey] = useState('back_in_stock');
  const preview = useQuery({ queryKey: ['email', 'template-preview', key], queryFn: () => apiFetch<{ subject: string; html: string }>(`/email/templates/${key}/preview`) });
  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <Card>
        <CardContent className="space-y-1 p-2 text-sm">
          {data?.map((t) => (
            <button key={t.key} onClick={() => setKey(t.key)} className={`block w-full rounded px-2 py-1 text-left ${t.key === key ? 'bg-[var(--color-accent)] font-medium' : ''}`}>
              {t.key} <span className="text-xs text-[var(--color-muted-foreground)]">· {t.class} · v{t.versions[0]?.version ?? 1}</span>
            </button>
          ))}
        </CardContent>
      </Card>
      <div className="space-y-2">
        <p className="text-sm text-[var(--color-muted-foreground)]">Layouts live in code (apps/api/src/modules/email/templates); this shows each with sample content. Campaign copy is edited on the campaign.</p>
        {preview.data && (
          <>
            <p className="text-sm"><strong>Subject:</strong> {preview.data.subject}</p>
            <iframe title="Template preview" className="h-[700px] w-full border border-[var(--color-border)] bg-white" srcDoc={preview.data.html} sandbox="" />
          </>
        )}
      </div>
    </div>
  );
}
