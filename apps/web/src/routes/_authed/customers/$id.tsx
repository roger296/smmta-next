import * as React from 'react';
import { createFileRoute, Link, useNavigate, useParams } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CustomerForm } from '@/features/customers/customer-form';
import {
  CustomerContactsTab,
  CustomerAddressesTab,
  CustomerNotesTab,
} from '@/features/customers/customer-tabs';
import {
  useCustomer,
  useDeleteCustomer,
  useUpdateCustomer,
  type CustomerDetail,
} from '@/features/customers/use-customers';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Trash2 } from 'lucide-react';

export const Route = createFileRoute('/_authed/customers/$id')({
  component: CustomerDetailPage,
});

function CustomerDetailPage() {
  const { id } = useParams({ from: '/_authed/customers/$id' });
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data, isLoading, isError, error } = useCustomer(id);
  const updateMutation = useUpdateCustomer();
  const deleteMutation = useDeleteCustomer();
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-6" role="alert">
          <p className="text-sm text-[var(--color-destructive)]">
            Failed to load customer: {error instanceof Error ? error.message : 'Not found'}
          </p>
          <Button variant="outline" className="mt-4" asChild>
            <Link to="/customers">
              <ArrowLeft className="h-4 w-4" /> Back to list
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }
  const customer = data as CustomerDetail;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link
            to="/customers"
            className="mb-2 inline-flex items-center text-sm text-[var(--color-muted-foreground)] hover:underline"
          >
            <ArrowLeft className="mr-1 h-3 w-3" />
            Customers
          </Link>
          <h1 className="text-2xl font-semibold">{customer.name}</h1>
          {customer.code && (
            <p className="text-sm text-[var(--color-muted-foreground)]">Code: {customer.code}</p>
          )}
        </div>
        <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
      </div>

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="contacts">
            Contacts {customer.contacts ? `(${customer.contacts.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="addresses">
            Addresses {customer.deliveryAddresses ? `(${customer.deliveryAddresses.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="notes">
            Notes {customer.notes ? `(${customer.notes.length})` : ''}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="general">
          <Card>
            <CardHeader>
              <CardTitle>Edit customer</CardTitle>
            </CardHeader>
            <CardContent>
              <CustomerForm
                defaultValues={{
                  name: customer.name,
                  shortName: customer.shortName ?? '',
                  typeId: customer.typeId ?? '',
                  email: customer.email ?? '',
                  creditLimit: Number(customer.creditLimit),
                  creditCurrencyCode: customer.creditCurrencyCode,
                  creditTermDays: customer.creditTermDays,
                  taxRatePercent: Number(customer.taxRatePercent),
                  vatTreatment: customer.vatTreatment,
                  vatRegistrationNumber: customer.vatRegistrationNumber ?? '',
                  countryCode: customer.countryCode ?? '',
                }}
                submitLabel="Save changes"
                onSubmit={async (values) => {
                  try {
                    await updateMutation.mutateAsync({ id: customer.id, input: values });
                    toast({ title: 'Customer updated' });
                  } catch (err) {
                    toast({
                      variant: 'destructive',
                      title: 'Update failed',
                      description: err instanceof Error ? err.message : 'Unknown error',
                    });
                  }
                }}
              />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="contacts">
          <CustomerContactsTab customer={customer} />
        </TabsContent>
        <TabsContent value="addresses">
          <CustomerAddressesTab customer={customer} />
        </TabsContent>
        <TabsContent value="notes">
          <CustomerNotesTab customer={customer} />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${customer.name}?`}
        description="This action cannot be undone. Related orders and invoices will remain but will show as 'Unknown customer'."
        destructive
        confirmLabel="Delete customer"
        onConfirm={async () => {
          try {
            await deleteMutation.mutateAsync(customer.id);
            toast({ title: 'Customer deleted' });
            navigate({ to: '/customers' });
          } catch (err) {
            toast({
              variant: 'destructive',
              title: 'Delete failed',
              description: err instanceof Error ? err.message : 'Unknown error',
            });
          }
        }}
      />
    </div>
  );
}
