import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import {
  TEMPLATE_KEYS,
  useAgentConfig,
  useGraduation,
  useSetAutoSend,
  type AgentConfigRow,
} from '@/features/agent-config/use-agent-config';

/**
 * Agent auto-send graduation (SPEC §17.6). Per message type: the rolling
 * approved-unedited rate + a reversible auto-send toggle. Auto-sent messages
 * still appear in the queue history + digest.
 */
export const Route = createFileRoute('/_authed/agents/')({
  component: AgentsPage,
});

function AgentsPage() {
  const { data: config } = useAgentConfig();
  const byKey = new Map<string, AgentConfigRow>((config ?? []).map((c) => [c.eventType, c]));

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Agent auto-send</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Enable auto-send per message type once you trust it. Everything still shows in the queue history and daily
          digest.
        </p>
      </div>
      <div className="space-y-3">
        {TEMPLATE_KEYS.map((key) => (
          <TemplateRow key={key} templateKey={key} enabled={byKey.get(key)?.autoSendEnabled ?? false} />
        ))}
      </div>
    </div>
  );
}

function TemplateRow({ templateKey, enabled }: { templateKey: string; enabled: boolean }) {
  const { toast } = useToast();
  const { data: stats } = useGraduation(templateKey);
  const setAutoSend = useSetAutoSend();

  const ratePct = stats ? Math.round(stats.approvedUneditedRate * 100) : null;
  const ready = stats != null && stats.sampleSize >= 20 && stats.approvedUneditedRate >= 0.95;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{templateKey.replace(/_/g, ' ')}</CardTitle>
          {ready && !enabled && <Badge variant="outline">ready to graduate</Badge>}
          {enabled && <Badge>auto-send on</Badge>}
        </div>
      </CardHeader>
      <CardContent className="flex items-center justify-between">
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {stats
            ? `${ratePct}% approved unedited (last ${stats.sampleSize})`
            : 'no history yet'}
        </p>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={enabled}
            onCheckedChange={(v) =>
              setAutoSend.mutate(
                { key: templateKey, enabled: v === true },
                {
                  onSuccess: () => toast({ title: v === true ? 'Auto-send enabled' : 'Auto-send disabled' }),
                  onError: () => toast({ title: 'Could not update', variant: 'destructive' }),
                },
              )
            }
          />
          Auto-send
        </label>
      </CardContent>
    </Card>
  );
}
