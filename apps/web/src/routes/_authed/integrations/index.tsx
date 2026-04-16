import { createFileRoute, Link } from '@tanstack/react-router';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Store, FileUp, Layers } from 'lucide-react';

export const Route = createFileRoute('/_authed/integrations/')({
  component: IntegrationsIndexPage,
});

function IntegrationsIndexPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Connect external services and run bulk operations.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Link to="/integrations/marketplace" className="block">
          <Card className="h-full transition-shadow hover:shadow-md">
            <CardHeader>
              <Store className="h-8 w-8 text-[var(--color-muted-foreground)]" aria-hidden />
              <CardTitle>Marketplace import</CardTitle>
              <CardDescription>Shopify, eBay, Etsy</CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link to="/integrations/csv" className="block">
          <Card className="h-full transition-shadow hover:shadow-md">
            <CardHeader>
              <FileUp className="h-8 w-8 text-[var(--color-muted-foreground)]" aria-hidden />
              <CardTitle>CSV order import</CardTitle>
              <CardDescription>Upload orders from a file</CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link to="/integrations/bulk" className="block">
          <Card className="h-full transition-shadow hover:shadow-md">
            <CardHeader>
              <Layers className="h-8 w-8 text-[var(--color-muted-foreground)]" aria-hidden />
              <CardTitle>Bulk operations</CardTitle>
              <CardDescription>Change status, allocate, invoice in bulk</CardDescription>
            </CardHeader>
          </Card>
        </Link>
      </div>
    </div>
  );
}
