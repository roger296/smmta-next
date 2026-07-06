import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import { DataTable } from '@/components/data-table/data-table';
import { formatDate } from '@/lib/format';
import type { ColumnDef } from '@tanstack/react-table';

/** Subscriptions overview (SPEC F4) — read-only operator view. */
export const Route = createFileRoute('/_authed/subscriptions/')({
  component: SubscriptionsPage,
});

interface SubRow {
  id: string;
  plan: string;
  status: 'active' | 'past_due' | 'paused' | 'cancelled';
  creditBalancePence: number;
  renewsAt: string | null;
  dunningAttempts: number;
  email: string | null;
  createdAt: string;
}

const gbp = (pence: number) => `£${(pence / 100).toFixed(2)}`;
const statusVariant: Record<SubRow['status'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
  active: 'default',
  past_due: 'destructive',
  paused: 'outline',
  cancelled: 'secondary',
};

const columns: ColumnDef<SubRow>[] = [
  { accessorKey: 'email', header: 'Customer', cell: ({ getValue }) => getValue<string>() ?? '—' },
  { accessorKey: 'plan', header: 'Plan' },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => <Badge variant={statusVariant[row.original.status]}>{row.original.status.replace(/_/g, ' ')}</Badge>,
  },
  { accessorKey: 'creditBalancePence', header: 'Credit', cell: ({ row }) => gbp(row.original.creditBalancePence) },
  { accessorKey: 'renewsAt', header: 'Renews', cell: ({ row }) => (row.original.renewsAt ? formatDate(row.original.renewsAt) : '—') },
];

function SubscriptionsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: () => apiFetch<SubRow[]>('/admin/subscriptions'),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Subscriptions</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Credit-bonus subscriptions and their billing state.</p>
      </div>
      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : data && data.length === 0 ? (
        <EmptyState icon={CreditCard} title="No subscriptions yet" />
      ) : (
        <DataTable columns={columns} data={data ?? []} />
      )}
    </div>
  );
}
