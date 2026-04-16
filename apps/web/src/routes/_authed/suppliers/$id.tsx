import * as React from 'react';
import { createFileRoute, Link, useNavigate, useParams } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { SupplierForm } from '@/features/suppliers/supplier-form';
import {
  SupplierContactsTab,
  SupplierAddressesTab,
  SupplierNotesTab,
} from '@/features/suppliers/supplier-tabs';
import {
  useSupplier,
  useUpdateSupplier,
  useDeleteSupplier,
  type SupplierDetail,
} from '@/features/suppliers/use-suppliers';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Trash2 } from 'lucide-react';

export const Route = createFileRoute('/_authed/suppliers/$id')({
  component: SupplierDetailPage,
});

function SupplierDetailPage() {
  const { id } = useParams({ from: '/_authed/suppliers/$id' });
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data, isLoading, isError, error } = useSupplier(id);
  const updateMutation = useUpdateSupplier();
  const deleteMutation = useDeleteSupplier();
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-6" role="alert">
          <p className="text-sm text-[var(--color-destructive)]">
            Failed to load: {error instanceof Error ? error.message : 'Not found'}
          </p>
          <Button variant="outline" className="mt-4" asChild>
            <Link to="/suppliers">
              <ArrowLeft className="h-4 w-4" />
              Back
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }
  const supplier = data as SupplierDetail;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link
            to="/suppliers"
            className="mb-2 inline-flex items-center text-sm text-[var(--color-muted-foreground)] hover:underline"
          >
            <ArrowLeft className="mr-1 h-3 w-3" />
            Suppliers
          </Link>
          <h1 className="text-2xl font-semibold">{supplier.name}</h1>
          {supplier.code && (
            <p className="text-sm text-[var(--color-muted-foreground)]">Code: {supplier.code}</p>
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
            Contacts {supplier.contacts ? `(${supplier.contacts.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="addresses">
            Addresses {supplier.addresses ? `(${supplier.addresses.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="notes">
            Notes {supplier.notes ? `(${supplier.notes.length})` : ''}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="general">
          <Card>
            <CardHeader>
              <CardTitle>Edit supplier</CardTitle>
            </CardHeader>
            <CardContent>
              <SupplierForm
                defaultValues={{
                  name: supplier.name,
                  type: supplier.type ?? '',
                  email: supplier.email ?? '',
                  accountsEmail: supplier.accountsEmail ?? '',
                  website: supplier.website ?? '',
                  currencyCode: supplier.currencyCode,
                  creditLimit: Number(supplier.creditLimit),
                  creditTermDays: supplier.creditTermDays,
                  taxRatePercent: Number(supplier.taxRatePercent),
                  vatTreatment: supplier.vatTreatment,
                  vatRegistrationNumber: supplier.vatRegistrationNumber ?? '',
                  countryCode: supplier.countryCode ?? '',
                  leadTimeDays: supplier.leadTimeDays ?? undefined,
                }}
                submitLabel="Save changes"
                onSubmit={async (values) => {
                  try {
                    await updateMutation.mutateAsync({ id: supplier.id, input: values });
                    toast({ title: 'Supplier updated' });
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
          <SupplierContactsTab supplier={supplier} />
        </TabsContent>
        <TabsContent value="addresses">
          <SupplierAddressesTab supplier={supplier} />
        </TabsContent>
        <TabsContent value="notes">
          <SupplierNotesTab supplier={supplier} />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${supplier.name}?`}
        description="This action cannot be undone."
        destructive
        confirmLabel="Delete supplier"
        onConfirm={async () => {
          try {
            await deleteMutation.mutateAsync(supplier.id);
            toast({ title: 'Supplier deleted' });
            navigate({ to: '/suppliers' });
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
