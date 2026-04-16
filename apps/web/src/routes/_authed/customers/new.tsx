import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CustomerForm } from '@/features/customers/customer-form';
import { useCreateCustomer } from '@/features/customers/use-customers';
import { useToast } from '@/hooks/use-toast';

export const Route = createFileRoute('/_authed/customers/new')({
  component: NewCustomerPage,
});

function NewCustomerPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const createMutation = useCreateCustomer();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">New customer</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Fill in the required fields; optional fields can be added later.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Customer details</CardTitle>
        </CardHeader>
        <CardContent>
          <CustomerForm
            submitLabel="Create customer"
            onCancel={() => navigate({ to: '/customers' })}
            onSubmit={async (values) => {
              try {
                const created = await createMutation.mutateAsync(values);
                toast({ title: 'Customer created', description: created.name });
                navigate({ to: '/customers/$id', params: { id: created.id } });
              } catch (err) {
                toast({
                  variant: 'destructive',
                  title: 'Could not create customer',
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
