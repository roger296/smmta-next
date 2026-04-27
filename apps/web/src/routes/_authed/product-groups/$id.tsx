import * as React from 'react';
import { createFileRoute, Link, useNavigate, useParams } from '@tanstack/react-router';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ProductGroupForm } from '@/features/product-groups/product-group-form';
import {
  useDeleteProductGroup,
  useProductGroup,
  useUpdateProductGroup,
} from '@/features/product-groups/use-product-groups';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Trash2 } from 'lucide-react';

export const Route = createFileRoute('/_authed/product-groups/$id')({
  component: ProductGroupDetailPage,
});

function ProductGroupDetailPage() {
  const { id } = useParams({ from: '/_authed/product-groups/$id' });
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data, isLoading, isError, error } = useProductGroup(id);
  const update = useUpdateProductGroup();
  const del = useDeleteProductGroup();
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
            <Link to="/product-groups">
              <ArrowLeft className="h-4 w-4" /> Back
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link
            to="/product-groups"
            className="mb-2 inline-flex items-center text-sm text-[var(--color-muted-foreground)] hover:underline"
          >
            <ArrowLeft className="mr-1 h-3 w-3" />
            Product groups
          </Link>
          <h1 className="text-2xl font-semibold">{data.name}</h1>
          {data.slug && (
            <p className="text-sm text-[var(--color-muted-foreground)]">/shop/{data.slug}</p>
          )}
        </div>
        <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
      </div>

      <ProductGroupForm
        group={data}
        products={data.products ?? []}
        isSaving={update.isPending}
        onSubmit={async (input) => {
          try {
            await update.mutateAsync({ id: data.id, input });
            toast({ title: 'Product group updated' });
          } catch (err) {
            toast({
              variant: 'destructive',
              title: 'Update failed',
              description: err instanceof Error ? err.message : 'Unknown error',
            });
          }
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${data.name}?`}
        description="Variants linked to this group will keep their group_id but the group will no longer appear on the storefront. This action can be reversed by re-creating the group."
        destructive
        confirmLabel="Delete group"
        onConfirm={async () => {
          try {
            await del.mutateAsync(data.id);
            toast({ title: 'Product group deleted' });
            navigate({ to: '/product-groups' });
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
