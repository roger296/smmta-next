import { createFileRoute, Link } from '@tanstack/react-router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { useDashboardKpis } from '@/features/dashboard/use-dashboard';
import { ORDER_STATUSES } from '@/features/orders/use-orders';
import { formatDate, formatMoney } from '@/lib/format';
import { CircleDollarSign, Package, ShoppingCart, Warehouse } from 'lucide-react';

export const Route = createFileRoute('/_authed/')({
  component: DashboardPage,
});

interface KpiCardProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  value: string;
  description?: string;
}

function KpiCard({ icon: Icon, title, value, description }: KpiCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
          {title}
        </CardTitle>
        <Icon className="h-4 w-4 text-[var(--color-muted-foreground)]" aria-hidden />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {description && <CardDescription className="mt-1">{description}</CardDescription>}
      </CardContent>
    </Card>
  );
}

function DashboardPage() {
  const { data, isLoading, isError } = useDashboardKpis();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-6" role="alert">
          <p className="text-sm text-[var(--color-destructive)]">
            Failed to load dashboard data.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Real-time overview of your business.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          icon={ShoppingCart}
          title="Open orders"
          value={String(data.openOrdersCount)}
          description={`${formatMoney(data.openOrdersValue)} in value`}
        />
        <KpiCard
          icon={Warehouse}
          title="Stock value"
          value={formatMoney(data.stockValue)}
          description="Across all warehouses"
        />
        <KpiCard
          icon={CircleDollarSign}
          title="Unpaid invoices"
          value={formatMoney(data.unpaidInvoicesTotal)}
          description="Customer debtors"
        />
        <KpiCard
          icon={Package}
          title="Unpaid bills"
          value={formatMoney(data.unpaidBillsTotal)}
          description="Supplier creditors"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent orders</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {data.recentOrders.length === 0 ? (
            <p className="p-6 text-sm text-[var(--color-muted-foreground)]">No orders yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Order #</th>
                  <th className="px-4 py-2 text-left font-medium">Customer</th>
                  <th className="px-4 py-2 text-left font-medium">Date</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.recentOrders.map((o) => {
                  const meta = ORDER_STATUSES.find((s) => s.value === o.status);
                  return (
                    <tr key={o.id} className="border-b border-[var(--color-border)] last:border-b-0">
                      <td className="px-4 py-2">
                        <Link
                          to="/orders/$id"
                          params={{ id: o.id }}
                          className="text-[var(--color-primary)] hover:underline"
                        >
                          {o.orderNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-2">{o.customerName ?? o.customerId.slice(0, 8)}</td>
                      <td className="px-4 py-2">{formatDate(o.orderDate)}</td>
                      <td className="px-4 py-2">
                        <Badge
                          variant={(meta?.color ?? 'outline') as 'default' | 'secondary' | 'destructive' | 'outline'}
                        >
                          {meta?.label ?? o.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 text-right">
                        {formatMoney(o.total, o.currencyCode)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
