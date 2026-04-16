import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SupplierForm } from '@/features/suppliers/supplier-form';
import { useCreateSupplier } from '@/features/suppliers/use-suppliers';
import { useToast } from '@/hooks/use-toast';

export const Route = createFileRoute('/_authed/suppliers/new')({
  component: NewSupplierPage,
});

function NewSupplierPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const createMutation = useCreateSupplier();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">New supplier</h1>
      <Card>
        <CardHeader>
          <CardTitle>Supplier details</CardTitle>
        </CardHeader>
        <CardContent>
          <SupplierForm
            submitLabel="Create supplier"
            onCancel={() => navigate({ to: '/suppliers' })}
            onSubmit={async (v) => {
              try {
                const created = await createMutation.mutateAsync(v);
                toast({ title: 'Supplier created', description: created.name });
                navigate({ to: '/suppliers/$id', params: { id: created.id } });
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
