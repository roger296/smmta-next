import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const Route = createFileRoute('/_authed/')({
  component: DashboardPage,
});

interface KpiCardProps {
  title: string;
  description: string;
  value: string;
}

function KpiCard({ title, description, value }: KpiCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <CardDescription className="mt-1">{description}</CardDescription>
      </CardContent>
    </Card>
  );
}

function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          KPIs will be live in Phase G.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KpiCard title="Open Orders" value="—" description="Orders not yet shipped" />
        <KpiCard title="Stock Value" value="—" description="Across all warehouses" />
        <KpiCard title="Unpaid Invoices" value="—" description="Customer debtors" />
        <KpiCard title="Unpaid Bills" value="—" description="Supplier creditors" />
      </div>
    </div>
  );
}
