import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { useCategoryTree } from '@/features/categories/use-categories';

export const Route = createFileRoute('/_authed/categories/')({
  component: CategoriesPage,
});

/**
 * Categories admin page (read-only V1).
 *
 * Shows the operator the hierarchical taxonomy + how many products
 * are assigned to each leaf, so they can spot:
 *   - Empty categories (rule coverage gap or genuinely no products)
 *   - The size of `Uncategorised` (the signal to add rules)
 *   - Imbalances (10k products in one bucket, 12 in another)
 *
 * Editing the taxonomy itself + the mapping rules lives in code
 * (`apps/api/src/modules/catalogue/taxonomy.ts` and `category-mapping.ts`).
 * Edit-in-SPA is a deliberate V2 follow-up so the operator's edits
 * can preview impact before applying them; we don't want a
 * one-click "reorganise the whole catalogue" button without that
 * safety net.
 */
function CategoriesPage() {
  const { data, isLoading, error } = useCategoryTree();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Categories</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          The Clothes Shop's two-tier taxonomy. Product counts reflect
          everything currently assigned. To rename, reorder, hide, or
          add categories, edit{' '}
          <code className="font-mono text-xs">apps/api/src/modules/catalogue/taxonomy.ts</code>{' '}
          and redeploy. To change which products land where, edit{' '}
          <code className="font-mono text-xs">apps/api/src/modules/catalogue/category-mapping.ts</code>{' '}
          and re-run{' '}
          <code className="font-mono text-xs">npm run assign-categories -w @smmta/api</code>.
        </p>
      </div>

      {isLoading && <Skeleton className="h-96 w-full" />}
      {error && (
        <Card>
          <CardContent className="py-6 text-sm text-[var(--color-destructive)]">
            Failed to load categories: {error instanceof Error ? error.message : 'unknown error'}
          </CardContent>
        </Card>
      )}

      {data && data.length === 0 && (
        <Card>
          <CardContent className="py-6 text-sm text-[var(--color-muted-foreground)]">
            No categories seeded yet. Run{' '}
            <code className="font-mono text-xs">npm run seed:categories -w @smmta/api</code>.
          </CardContent>
        </Card>
      )}

      {data && data.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {data
            .slice()
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((top) => (
              <Card key={top.id}>
                <CardHeader className="pb-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <CardTitle className="text-base">
                      {top.name}
                      {top.isHidden && (
                        <Badge variant="secondary" className="ml-2 text-xs">
                          hidden
                        </Badge>
                      )}
                    </CardTitle>
                    <span className="text-xs font-mono text-[var(--color-muted-foreground)]">
                      {top.productCount.toLocaleString()} products
                    </span>
                  </div>
                  {top.description && (
                    <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                      {top.description}
                    </p>
                  )}
                </CardHeader>
                <CardContent className="pt-0">
                  {top.children.length === 0 ? (
                    <p className="text-xs italic text-[var(--color-muted-foreground)]">
                      (no subcategories)
                    </p>
                  ) : (
                    <ul className="space-y-1.5 text-sm">
                      {top.children
                        .slice()
                        .sort((a, b) => a.sortOrder - b.sortOrder)
                        .map((sub) => (
                          <li
                            key={sub.id}
                            className="flex items-baseline justify-between gap-2 border-b border-[var(--color-border)] pb-1.5 last:border-b-0"
                          >
                            <span>{sub.name}</span>
                            <span className="font-mono text-xs text-[var(--color-muted-foreground)]">
                              {sub.productCount.toLocaleString()}
                            </span>
                          </li>
                        ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            ))}
        </div>
      )}
    </div>
  );
}
