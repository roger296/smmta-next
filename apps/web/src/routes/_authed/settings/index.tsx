import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/empty-state';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useToast } from '@/hooks/use-toast';
import {
  useWarehouses,
  useDeleteWarehouse,
  useCategories,
  useCreateCategory,
  useUpdateCategory,
  useDeleteCategory,
  useManufacturers,
  useCreateManufacturer,
  useUpdateManufacturer,
  useDeleteManufacturer,
} from '@/features/reference/use-reference';
import {
  useCustomerTypes,
  useCreateCustomerType,
  useUpdateCustomerType,
  useDeleteCustomerType,
} from '@/features/customers/use-customers';
import { WarehouseDialog, SimpleNameDialog } from '@/features/reference/warehouse-dialog';
import { useYearEndClose } from '@/features/integrations/use-integrations';
import type { Category, Manufacturer, Warehouse, CustomerType } from '@/lib/api-types';
import { Edit, Plus, Trash2, Warehouse as WarehouseIcon, Tag, Factory, Users, Calendar } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export const Route = createFileRoute('/_authed/settings/')({
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Reference data used across the app.
        </p>
      </div>
      <Tabs defaultValue="warehouses">
        <TabsList>
          <TabsTrigger value="warehouses">Warehouses</TabsTrigger>
          <TabsTrigger value="categories">Categories</TabsTrigger>
          <TabsTrigger value="manufacturers">Manufacturers</TabsTrigger>
          <TabsTrigger value="customer-types">Customer types</TabsTrigger>
          <TabsTrigger value="year-end">Year-end close</TabsTrigger>
        </TabsList>
        <TabsContent value="warehouses">
          <WarehousesPanel />
        </TabsContent>
        <TabsContent value="categories">
          <CategoriesPanel />
        </TabsContent>
        <TabsContent value="manufacturers">
          <ManufacturersPanel />
        </TabsContent>
        <TabsContent value="customer-types">
          <CustomerTypesPanel />
        </TabsContent>
        <TabsContent value="year-end">
          <YearEndPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function YearEndPanel() {
  const { toast } = useToast();
  const mutation = useYearEndClose();
  const [fromDate, setFromDate] = React.useState('');
  const [toDate, setToDate] = React.useState('');
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-6">
          <div className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-[var(--color-muted-foreground)]" aria-hidden />
            <h3 className="text-base font-medium">Close financial year</h3>
          </div>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            This posts a year-end close to the Luca GL via the API. All periods within the range
            must be reconciled. This action cannot be undone.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ye-from">From date</Label>
              <Input
                id="ye-from"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ye-to">To date</Label>
              <Input
                id="ye-to"
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              variant="destructive"
              disabled={!fromDate || !toDate}
              onClick={() => setConfirmOpen(true)}
            >
              Close year
            </Button>
          </div>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Close the financial year?"
        description={`This will post a year-end close for ${fromDate} → ${toDate} to the GL. This cannot be undone.`}
        destructive
        confirmLabel="Close year"
        onConfirm={async () => {
          try {
            await mutation.mutateAsync({ fromDate, toDate });
            toast({ title: 'Year closed successfully' });
          } catch (err) {
            toast({
              variant: 'destructive',
              title: 'Year-end close failed',
              description: err instanceof Error ? err.message : 'Unknown',
            });
          }
        }}
      />
    </div>
  );
}

function WarehousesPanel() {
  const { toast } = useToast();
  const { data, isLoading } = useWarehouses();
  const deleteMutation = useDeleteWarehouse();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Warehouse | null>(null);
  const [toDelete, setToDelete] = React.useState<Warehouse | null>(null);

  if (isLoading) return <Skeleton className="h-32 w-full" />;

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
          New warehouse
        </Button>
      </div>
      {data?.length === 0 ? (
        <EmptyState icon={WarehouseIcon} title="No warehouses yet" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Name</th>
                  <th className="px-4 py-2 text-left font-medium">City</th>
                  <th className="px-4 py-2 text-left font-medium">Country</th>
                  <th className="w-24 px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {data?.map((w) => (
                  <tr key={w.id} className="border-b border-[var(--color-border)] last:border-b-0">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        {w.name}
                        {w.isDefault && <Badge variant="secondary">Default</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-2">{w.city ?? '—'}</td>
                    <td className="px-4 py-2">{w.country ?? '—'}</td>
                    <td className="flex gap-1 px-4 py-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${w.name}`}
                        onClick={() => {
                          setEditing(w);
                          setDialogOpen(true);
                        }}
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${w.name}`}
                        onClick={() => setToDelete(w)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
      <WarehouseDialog open={dialogOpen} onOpenChange={setDialogOpen} warehouse={editing} />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`Delete ${toDelete?.name ?? ''}?`}
        destructive
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!toDelete) return;
          await deleteMutation.mutateAsync(toDelete.id);
          toast({ title: 'Warehouse deleted' });
          setToDelete(null);
        }}
      />
    </>
  );
}

function CategoriesPanel() {
  const { toast } = useToast();
  const { data, isLoading } = useCategories();
  const createMutation = useCreateCategory();
  const updateMutation = useUpdateCategory();
  const deleteMutation = useDeleteCategory();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Category | null>(null);
  const [toDelete, setToDelete] = React.useState<Category | null>(null);

  if (isLoading) return <Skeleton className="h-32 w-full" />;

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
          New category
        </Button>
      </div>
      {data?.length === 0 ? (
        <EmptyState icon={Tag} title="No categories yet" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul>
              {data?.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3 last:border-b-0"
                >
                  <span className="text-sm">{c.name}</span>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${c.name}`}
                      onClick={() => {
                        setEditing(c);
                        setDialogOpen(true);
                      }}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${c.name}`}
                      onClick={() => setToDelete(c)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <SimpleNameDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editing ? 'Edit category' : 'New category'}
        initialName={editing?.name}
        onSubmit={async (name) => {
          if (editing) {
            await updateMutation.mutateAsync({ id: editing.id, input: { name } });
            toast({ title: 'Category updated' });
          } else {
            await createMutation.mutateAsync({ name });
            toast({ title: 'Category created' });
          }
        }}
      />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`Delete ${toDelete?.name ?? ''}?`}
        destructive
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!toDelete) return;
          await deleteMutation.mutateAsync(toDelete.id);
          toast({ title: 'Category deleted' });
          setToDelete(null);
        }}
      />
    </>
  );
}

function ManufacturersPanel() {
  const { toast } = useToast();
  const { data, isLoading } = useManufacturers();
  const createMutation = useCreateManufacturer();
  const updateMutation = useUpdateManufacturer();
  const deleteMutation = useDeleteManufacturer();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Manufacturer | null>(null);
  const [toDelete, setToDelete] = React.useState<Manufacturer | null>(null);

  if (isLoading) return <Skeleton className="h-32 w-full" />;

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
          New manufacturer
        </Button>
      </div>
      {data?.length === 0 ? (
        <EmptyState icon={Factory} title="No manufacturers yet" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul>
              {data?.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3 last:border-b-0"
                >
                  <div>
                    <p className="text-sm font-medium">{m.name}</p>
                    {m.website && (
                      <p className="text-xs text-[var(--color-muted-foreground)]">{m.website}</p>
                    )}
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${m.name}`}
                      onClick={() => {
                        setEditing(m);
                        setDialogOpen(true);
                      }}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${m.name}`}
                      onClick={() => setToDelete(m)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <SimpleNameDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editing ? 'Edit manufacturer' : 'New manufacturer'}
        initialName={editing?.name}
        onSubmit={async (name) => {
          if (editing) {
            await updateMutation.mutateAsync({ id: editing.id, input: { name } });
            toast({ title: 'Manufacturer updated' });
          } else {
            await createMutation.mutateAsync({ name });
            toast({ title: 'Manufacturer created' });
          }
        }}
      />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`Delete ${toDelete?.name ?? ''}?`}
        destructive
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!toDelete) return;
          await deleteMutation.mutateAsync(toDelete.id);
          toast({ title: 'Manufacturer deleted' });
          setToDelete(null);
        }}
      />
    </>
  );
}

function CustomerTypesPanel() {
  const { toast } = useToast();
  const { data, isLoading } = useCustomerTypes();
  const createMutation = useCreateCustomerType();
  const updateMutation = useUpdateCustomerType();
  const deleteMutation = useDeleteCustomerType();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CustomerType | null>(null);
  const [toDelete, setToDelete] = React.useState<CustomerType | null>(null);

  if (isLoading) return <Skeleton className="h-32 w-full" />;

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4" />
          New customer type
        </Button>
      </div>
      {data?.length === 0 ? (
        <EmptyState icon={Users} title="No customer types yet" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul>
              {data?.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3 last:border-b-0"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{t.name}</span>
                    {t.isDefault && <Badge variant="secondary">Default</Badge>}
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${t.name}`}
                      onClick={() => {
                        setEditing(t);
                        setDialogOpen(true);
                      }}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${t.name}`}
                      onClick={() => setToDelete(t)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <SimpleNameDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editing ? 'Edit customer type' : 'New customer type'}
        initialName={editing?.name}
        onSubmit={async (name) => {
          if (editing) {
            await updateMutation.mutateAsync({ typeId: editing.id, input: { name } });
            toast({ title: 'Customer type updated' });
          } else {
            await createMutation.mutateAsync({ name });
            toast({ title: 'Customer type created' });
          }
        }}
      />
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={`Delete ${toDelete?.name ?? ''}?`}
        destructive
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!toDelete) return;
          await deleteMutation.mutateAsync(toDelete.id);
          toast({ title: 'Customer type deleted' });
          setToDelete(null);
        }}
      />
    </>
  );
}
