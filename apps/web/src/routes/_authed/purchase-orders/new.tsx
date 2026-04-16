import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { POForm } from '@/features/purchasing/po-form';
import { useCreatePurchaseOrder } from '@/features/purchasing/use-purchasing';
import { useToast } from '@/hooks/use-toast';

export const Route = createFileRoute('/_authed/purchase-orders/new')({
  component: NewPurchaseOrderPage,
});

function NewPurchaseOrderPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const createMutation = useCreatePurchaseOrder();

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">New purchase order</h1>
      <Card>
        <CardHeader>
          <CardTitle>PO details</CardTitle>
        </CardHeader>
        <CardContent>
          <POForm
            onCancel={() => navigate({ to: '/purchase-orders' })}
            onSubmit={async (v) => {
              try {
                const created = await createMutation.mutateAsync(v as never);
                toast({ title: 'PO created', description: created.poNumber });
                navigate({ to: '/purchase-orders/$id', params: { id: created.id } });
              } catch (err) {
                toast({
                  variant: 'destructive',
                  title: 'Could not create',
                  description: err instanceof Error ? err.message : 'Unknown',
                });
              }
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
