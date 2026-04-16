import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { OrderForm } from '@/features/orders/order-form';
import { useCreateOrder } from '@/features/orders/use-orders';
import { useToast } from '@/hooks/use-toast';

export const Route = createFileRoute('/_authed/orders/new')({
  component: NewOrderPage,
});

function NewOrderPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const createMutation = useCreateOrder();

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-2xl font-semibold">New order</h1>
      <Card>
        <CardHeader>
          <CardTitle>Order details</CardTitle>
        </CardHeader>
        <CardContent>
          <OrderForm
            onCancel={() => navigate({ to: '/orders' })}
            onSubmit={async (v) => {
              try {
                const created = await createMutation.mutateAsync(v as never);
                toast({ title: 'Order created', description: created.orderNumber });
                navigate({ to: '/orders/$id', params: { id: created.id } });
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
