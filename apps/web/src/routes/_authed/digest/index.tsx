import { createFileRoute, Link } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useDigest } from '@/features/digest/use-digest';

/** Daily digest, on demand (SPEC §6, §17.9) — the solo-operator cockpit. */
export const Route = createFileRoute('/_authed/digest/')({
  component: DigestPage,
});

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'warn' }) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-medium text-[var(--color-muted-foreground)]">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className={`text-2xl font-semibold ${tone === 'warn' ? 'text-red-600' : ''}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

function DigestPage() {
  const { data: d, isLoading } = useDigest();

  if (isLoading || !d) {
    return (
      <div className="mx-auto max-w-3xl">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const spend = `$${(d.llmSpend.spentMicroUsd / 1_000_000).toFixed(2)} / $${(d.llmSpend.capMicroUsd / 1_000_000).toFixed(2)}`;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Daily digest</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">{d.date}</p>
        </div>
        <Link to="/approval" className="text-sm underline">
          Go to queue →
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Awaiting approval" value={d.queue.pending} />
        <Stat label="Open escalations" value={d.openEscalations} tone={d.openEscalations > 0 ? 'warn' : undefined} />
        <Stat label="Auto-sent" value={d.autoSent} />
        <Stat label="Expired drafts" value={d.expiredDrafts} tone={d.expiredDrafts > 0 ? 'warn' : undefined} />
        <Stat label="Payments awaiting" value={d.paymentWindow.awaiting} />
        <Stat label="Overdue payments" value={d.paymentWindow.overdue} tone={d.paymentWindow.overdue > 0 ? 'warn' : undefined} />
        <Stat label="Renewals (7d)" value={d.upcomingRenewals} />
        <Stat label="Job failures" value={d.jobFailures} tone={d.jobFailures > 0 ? 'warn' : undefined} />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            LLM spend today {d.llmSpend.overCap && <Badge variant="destructive">over cap</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">{spend}</CardContent>
      </Card>

      {Object.keys(d.queue.byType).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Queue by type</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {Object.entries(d.queue.byType).map(([type, n]) => (
              <Badge key={type} variant="secondary">
                {type}: {n}
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}

      {Object.keys(d.marketingSegments).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Marketing composed today</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {Object.entries(d.marketingSegments).map(([seg, n]) => (
              <Badge key={seg} variant="outline">
                {seg}: {n}
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
