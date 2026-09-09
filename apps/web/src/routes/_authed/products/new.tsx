import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ProductForm, productToFormValues } from '@/features/products/product-form';
import { useCreateProduct, useProduct } from '@/features/products/use-products';
import { useToast } from '@/hooks/use-toast';

export interface NewProductSearch {
  /** Product to copy field values from, set by "Duplicate product". */
  duplicateFrom?: string;
}

export const Route = createFileRoute('/_authed/products/new')({
  validateSearch: (search: Record<string, unknown>): NewProductSearch => ({
    duplicateFrom:
      typeof search.duplicateFrom === 'string' && search.duplicateFrom.length > 0
        ? search.duplicateFrom
        : undefined,
  }),
  component: NewProductPage,
});

function NewProductPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const createMutation = useCreateProduct();
  const { duplicateFrom } = useSearch({ from: '/_authed/products/new' });

  // Only fetches when duplicating; useProduct is disabled for an undefined id.
  const { data: source, isLoading, isError } = useProduct(duplicateFrom);

  // Wait for the source before rendering the form. react-hook-form reads
  // defaultValues once on mount, so a form mounted with empty values would stay
  // empty when the product arrived — the button would look like it did nothing.
  if (duplicateFrom && isLoading) {
    return <Skeleton className="h-96 w-full" />;
  }

  // Name and stock code are deliberately not copied: the stock code is unique
  // per product and the API rejects a duplicate, so carrying it over would only
  // produce a failed save.
  const defaultValues =
    duplicateFrom && source ? productToFormValues(source, ['name', 'stockCode']) : undefined;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">
        {duplicateFrom && source ? `Duplicate of ${source.name}` : 'New product'}
      </h1>
      {duplicateFrom && isError && (
        <p className="text-sm text-[var(--color-destructive)]" role="alert">
          Could not load the product to copy — the fields below are blank. Go back and try again
          rather than filling them in by hand, in case some were meant to be copied.
        </p>
      )}
      {defaultValues && (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Every field has been copied from {source?.name} except the name and stock code, which must
          be unique. Images, storefront content, channels and stock are not copied.
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Product details</CardTitle>
        </CardHeader>
        <CardContent>
          <ProductForm
            defaultValues={defaultValues}
            submitLabel="Create product"
            onCancel={() => navigate({ to: '/products' })}
            onSubmit={async (v) => {
              try {
                const created = await createMutation.mutateAsync(v);
                toast({ title: 'Product created', description: created.name });
                navigate({ to: '/products/$id', params: { id: created.id } });
              } catch (err) {
                toast({
                  variant: 'destructive',
                  title: 'Could not create',
                  description: err instanceof Error ? err.message : 'Unknown error',
                });
              }
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
