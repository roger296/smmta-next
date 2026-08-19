import { createFileRoute, Link } from '@tanstack/react-router';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import { ISSUE_LABELS, useNeedsSetup } from '@/features/products/use-needs-setup';

export const Route = createFileRoute('/_authed/products/needs-setup')({
  component: NeedsSetupPage,
});

/**
 * Products not ready for a venue to receive (Aug-2026 feedback, C-1/C-2/C-4).
 *
 * The 12 Aug session hit "icing sugar displayed an incorrect default unit
 * quantity of 1kg" and "Skittles displayed an incorrect base unit" because
 * those products had no purchase model — and nothing anywhere said so. This is
 * the list to work to zero *before* the next test, rather than discovering it
 * on a pallet.
 */
function NeedsSetupPage() {
  const { data, isLoading } = useNeedsSetup();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const rows = data?.rows ?? [];
  const summary = data?.summary;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Products needing setup</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Every stocked product a venue cannot receive correctly yet. A product with no purchase
          unit shows a 25&nbsp;kg sack as &ldquo;= 1 g&rdquo;; one with no cost books at
          £0.00. Work this list to zero before a venue test.
        </p>
      </div>

      {summary && rows.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {(Object.keys(ISSUE_LABELS) as Array<keyof typeof ISSUE_LABELS>).map((kind) =>
            summary.byIssue[kind] > 0 ? (
              <Badge key={kind} variant="secondary">
                {ISSUE_LABELS[kind]}: {summary.byIssue[kind]}
              </Badge>
            ) : null,
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="Nothing to set up"
          description="Every stocked product has a purchase unit, a conversion factor and a cost."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-[var(--color-destructive)]" aria-hidden />
              {rows.length} product{rows.length === 1 ? '' : 's'} to fix
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-[var(--color-border)]">
              {rows.map((row) => (
                <li key={row.id} className="p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <Link
                      to="/products/$id"
                      params={{ id: row.id }}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {row.name}
                    </Link>
                    <span className="text-xs text-[var(--color-muted-foreground)]">
                      {row.stockCode ?? 'no stock code'} · stocked in {row.stockUom}
                      {row.purchaseUom ? ` · bought in ${row.purchaseUom}` : ''}
                    </span>
                  </div>
                  <ul className="mt-2 space-y-1">
                    {row.issues.map((issue) => (
                      <li key={issue.kind} className="text-sm text-[var(--color-muted-foreground)]">
                        <Badge variant="outline" className="mr-2">
                          {ISSUE_LABELS[issue.kind]}
                        </Badge>
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
