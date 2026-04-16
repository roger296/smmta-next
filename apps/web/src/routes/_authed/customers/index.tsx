import { createFileRoute } from '@tanstack/react-router';
import { useCustomersList } from '@/features/customers/use-customers';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Users } from 'lucide-react';

export const Route = createFileRoute('/_authed/customers/')({
  component: CustomersListPage,
});

function CustomersListPage() {
  const { data, isLoading, isError, error } = useCustomersList({ page: 1, pageSize: 50 });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Customers</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Manage customer accounts and related records.
          </p>
        </div>
      </div>

      {isLoading && (
        <Card>
          <CardContent className="space-y-2 p-6">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      )}

      {isError && (
        <Card>
          <CardContent className="p-6" role="alert">
            <p className="text-sm text-[var(--color-destructive)]">
              Failed to load customers: {error instanceof Error ? error.message : 'Unknown error'}
            </p>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && data && data.data.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Users className="h-12 w-12 text-[var(--color-muted-foreground)]" aria-hidden />
            <p className="text-base font-medium">No customers yet</p>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Create your first customer to get started. (Create flow arrives in Phase B.)
            </p>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && data && data.data.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Name</th>
                  <th className="px-4 py-2 text-left font-medium">Email</th>
                  <th className="px-4 py-2 text-left font-medium">Code</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((customer) => (
                  <tr
                    key={customer.id}
                    className="border-b border-[var(--color-border)] last:border-b-0"
                  >
                    <td className="px-4 py-2">{customer.name}</td>
                    <td className="px-4 py-2">{customer.email ?? '—'}</td>
                    <td className="px-4 py-2">{customer.code ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
