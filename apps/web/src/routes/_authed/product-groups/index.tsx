import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/empty-state';
import { useProductGroupsList } from '@/features/product-groups/use-product-groups';
import { Layers, Plus } from 'lucide-react';

export const Route = createFileRoute('/_authed/product-groups/')({
  component: ProductGroupsListPage,
});

function ProductGroupsListPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = useProductGroupsList();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Product groups</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Customer-facing ranges. Group your colour variants here, then assign individual products
            to a group from each product&rsquo;s Storefront tab.
          </p>
        </div>
        <Button asChild>
          <Link to="/product-groups/new">
            <Plus className="h-4 w-4" />
            New group
          </Link>
        </Button>
      </div>

      {isLoading && <Skeleton className="h-64 w-full" />}
      {isError && (
        <Card>
          <CardContent className="p-6" role="alert">
            <p className="text-sm text-[var(--color-destructive)]">
              Failed to load: {error instanceof Error ? error.message : 'Unknown error'}
            </p>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && data && data.length === 0 && (
        <EmptyState
          icon={Layers}
          title="No product groups yet"
          action={
            <Button asChild>
              <Link to="/product-groups/new">
                <Plus className="h-4 w-4" />
                New group
              </Link>
            </Button>
          }
        />
      )}

      {!isLoading && !isError && data && data.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {data.map((g) => (
            <Card
              key={g.id}
              className="cursor-pointer transition hover:border-[var(--color-foreground)]"
              onClick={() => navigate({ to: '/product-groups/$id', params: { id: g.id } })}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  navigate({ to: '/product-groups/$id', params: { id: g.id } });
                }
              }}
            >
              <CardContent className="space-y-2 p-4">
                <div className="flex items-start justify-between">
                  <h3 className="font-medium">{g.name}</h3>
                  {g.isPublished ? (
                    <Badge variant="outline">Published</Badge>
                  ) : (
                    <Badge variant="secondary">Draft</Badge>
                  )}
                </div>
                {g.shortDescription && (
                  <p className="line-clamp-2 text-sm text-[var(--color-muted-foreground)]">
                    {g.shortDescription}
                  </p>
                )}
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  {g.slug ? `/shop/${g.slug}` : 'No slug yet'}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
