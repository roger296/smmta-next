import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useOutbox } from '@/features/outbox/use-outbox';

/**
 * Email outbox health.
 *
 * Built after a run of order confirmations failed silently: the rows said
 * FAILED with the error "Forbidden" and nothing else, and answering "is email
 * working?" needed a shell on the host. The three states an operator actually
 * has to tell apart are a clear queue, a stalled drainer, and a provider
 * rejection — so those are what this leads with.
 */
export const Route = createFileRoute('/_authed/outbox/')({
  component: OutboxPage,
});

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'warn';
  hint?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-medium text-[var(--color-muted-foreground)]">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className={`text-2xl font-semibold ${tone === 'warn' ? 'text-red-600' : ''}`}>{value}</p>
        {hint && <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function humaniseAge(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

function OutboxPage() {
  const { data, isLoading, error } = useOutbox();

  if (error) {
    return (
      <div className="mx-auto max-w-3xl">
        <Card>
          <CardHeader>
            <CardTitle className="text-red-600">Outbox unavailable</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {error instanceof Error ? error.message : 'Could not read the outbox.'}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="mx-auto max-w-4xl">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // A queue that is merely busy drains on its own; one that is old is stuck.
  const stalled = (data.oldestUnsentAgeSeconds ?? 0) > 600;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Email outbox</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Order confirmations and back-in-stock alerts. The drainer runs every 60 seconds.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Waiting to send" value={data.counts.PENDING} />
        <Stat
          label="Oldest unsent"
          value={
            data.oldestUnsentAgeSeconds === null
              ? '—'
              : humaniseAge(data.oldestUnsentAgeSeconds)
          }
          tone={stalled ? 'warn' : undefined}
          hint={stalled ? 'Older than 10 min — the drainer may be down' : undefined}
        />
        <Stat
          label="Retrying"
          value={data.awaitingRetry}
          hint={data.awaitingRetry > 0 ? 'Transient failures, will retry automatically' : undefined}
        />
        <Stat
          label="Stuck"
          value={data.stuck}
          tone={data.stuck > 0 ? 'warn' : undefined}
          hint={data.stuck > 0 ? 'Will not retry without intervention' : undefined}
        />
      </div>

      <p className="text-xs text-[var(--color-muted-foreground)]">
        {data.counts.SENT} sent all time
        {data.lastSentAt && ` · last at ${new Date(data.lastSentAt).toLocaleString('en-GB')}`}
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent failures</CardTitle>
        </CardHeader>
        <CardContent>
          {data.recentFailures.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No failures recorded.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left">
                    <th className="px-2 py-2 font-medium">Recipient</th>
                    <th className="px-2 py-2 font-medium">Template</th>
                    <th className="px-2 py-2 font-medium">Status</th>
                    <th className="px-2 py-2 font-medium">Tries</th>
                    <th className="px-2 py-2 font-medium">Next try</th>
                    <th className="px-2 py-2 font-medium">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentFailures.map((f) => (
                    <tr key={f.id} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="px-2 py-2 align-top">{f.toEmail}</td>
                      <td className="px-2 py-2 align-top">{f.template}</td>
                      <td className="px-2 py-2 align-top">
                        {f.statusCode ? <Badge variant="outline">{f.statusCode}</Badge> : '—'}
                      </td>
                      <td className="px-2 py-2 align-top">{f.attempts}</td>
                      <td className="px-2 py-2 align-top">
                        {f.nextAttemptAt ? (
                          new Date(f.nextAttemptAt).toLocaleString('en-GB')
                        ) : (
                          <span className="text-red-600">never</span>
                        )}
                      </td>
                      {/* The whole point of this page: the provider's actual
                          words, not just the HTTP status text. */}
                      <td className="px-2 py-2 align-top">
                        <pre className="whitespace-pre-wrap break-words font-sans text-xs">
                          {f.error ?? '—'}
                        </pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
