import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ProductForm } from '@/features/products/product-form';
import { useCreateProduct } from '@/features/products/use-products';
import { useToast } from '@/hooks/use-toast';

export const Route = createFileRoute('/_authed/products/new')({
  component: NewProductPage,
});

function NewProductPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const createMutation = useCreateProduct();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">New product</h1>
      <Card>
        <CardHeader>
          <CardTitle>Product details</CardTitle>
        </CardHeader>
        <CardContent>
          <ProductForm
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
