import * as React from 'react';
import { createFileRoute, Link, useNavigate, useParams } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ProductForm } from '@/features/products/product-form';
import { ProductImagesTab, ProductStockTab } from '@/features/products/product-tabs';
import { StorefrontTab } from '@/features/products/storefront-tab';
import { ChannelsTab } from '@/features/channels/channels-tab';
import { SupplierMappingsTab } from '@/features/suppliers-dropship/supplier-mappings-tab';
import {
  useDeleteProduct,
  useProduct,
  useUpdateProduct,
} from '@/features/products/use-products';
import { useToast } from '@/hooks/use-toast';
import { AlertTriangle, ArrowLeft, Trash2 } from 'lucide-react';

export const Route = createFileRoute('/_authed/products/$id')({
  component: ProductDetailPage,
});

function ProductDetailPage() {
  const { id } = useParams({ from: '/_authed/products/$id' });
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data, isLoading, isError, error } = useProduct(id);
  const updateMutation = useUpdateProduct();
  const deleteMutation = useDeleteProduct();
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  // A refusal-to-delete is long ("still has stock at 3 sites: … and is an
  // ingredient in 2 recipes: …") and actionable. A toast shows it for four
  // seconds and then takes it away, which is the opposite of helpful, so it
  // gets a place on the page until the user has dealt with it.
  const [blockedBy, setBlockedBy] = React.useState<string | null>(null);

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-6" role="alert">
          <p className="text-sm text-[var(--color-destructive)]">
            Failed to load: {error instanceof Error ? error.message : 'Not found'}
          </p>
          <Button variant="outline" className="mt-4" asChild>
            <Link to="/products">
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
            to="/products"
            className="mb-2 inline-flex items-center text-sm text-[var(--color-muted-foreground)] hover:underline"
          >
            <ArrowLeft className="mr-1 h-3 w-3" />
            Products
          </Link>
          <h1 className="text-2xl font-semibold">{data.name}</h1>
          {data.stockCode && (
            <p className="text-sm text-[var(--color-muted-foreground)]">SKU: {data.stockCode}</p>
          )}
        </div>
        <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
      </div>

      {blockedBy && (
        <Card className="border-[var(--color-destructive)]">
          <CardContent className="flex items-start gap-3 p-4" role="alert">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-destructive)]" />
            <div className="space-y-1">
              <p className="text-sm font-medium">This product cannot be deleted yet</p>
              <p className="text-sm text-[var(--color-muted-foreground)]">{blockedBy}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => setBlockedBy(null)}
              aria-label="Dismiss"
            >
              Dismiss
            </Button>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="storefront">Storefront</TabsTrigger>
          <TabsTrigger value="channels">Channels</TabsTrigger>
          <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
          <TabsTrigger value="images">Images</TabsTrigger>
          <TabsTrigger value="stock">Stock</TabsTrigger>
        </TabsList>
        <TabsContent value="general">
          <Card>
            <CardHeader>
              <CardTitle>Edit product</CardTitle>
            </CardHeader>
            <CardContent>
              <ProductForm
                defaultValues={{
                  name: data.name,
                  stockCode: data.stockCode ?? '',
                  manufacturerId: data.manufacturerId ?? '',
                  manufacturerPartNumber: data.manufacturerPartNumber ?? '',
                  description: data.description ?? '',
                  expectedNextCost: Number(data.expectedNextCost),
                  minSellingPrice: data.minSellingPrice ? Number(data.minSellingPrice) : undefined,
                  maxSellingPrice: data.maxSellingPrice ? Number(data.maxSellingPrice) : undefined,
                  ean: data.ean ?? '',
                  productType: data.productType,
                  requireSerialNumber: data.requireSerialNumber,
                  requireBatchNumber: data.requireBatchNumber,
                  weight: data.weight ? Number(data.weight) : undefined,
                  countryOfOrigin: data.countryOfOrigin ?? '',
                  hsCode: data.hsCode ?? '',
                  supplierId: data.supplierId ?? '',
                  defaultWarehouseId: data.defaultWarehouseId ?? '',
                  itemKind: data.itemKind,
                  isSold: data.isSold,
                  isStocked: data.isStocked,
                  barcode: data.barcode ?? '',
                  referenceImageUrl: data.referenceImageUrl ?? '',
                  stockUom: data.stockUom ?? '',
                  purchaseUom: data.purchaseUom ?? '',
                  packDescription: data.packDescription ?? '',
                  purchasePackSize: data.purchasePackSize ? Number(data.purchasePackSize) : undefined,
                  purchaseToStockFactor: data.purchaseToStockFactor
                    ? Number(data.purchaseToStockFactor)
                    : undefined,
                  countQuantum: data.countQuantum ? Number(data.countQuantum) : null,
                }}
                submitLabel="Save changes"
                onSubmit={async (v) => {
                  try {
                    await updateMutation.mutateAsync({ id: data.id, input: v });
                    toast({ title: 'Product updated' });
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
        <TabsContent value="storefront">
          <StorefrontTab product={data} />
        </TabsContent>
        <TabsContent value="channels">
          <ChannelsTab productId={data.id} basePriceGbp={data.minSellingPrice ?? null} />
        </TabsContent>
        <TabsContent value="suppliers">
          <SupplierMappingsTab productId={data.id} />
        </TabsContent>
        <TabsContent value="images">
          <ProductImagesTab productId={data.id} />
        </TabsContent>
        <TabsContent value="stock">
          <ProductStockTab productId={data.id} />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${data.name}?`}
        description="This action cannot be undone."
        destructive
        confirmLabel="Delete product"
        onConfirm={async () => {
          try {
            await deleteMutation.mutateAsync(data.id);
            toast({ title: 'Product deleted' });
            navigate({ to: '/products' });
          } catch (err) {
            // 409 = still in use. Not an error the user can retry past; it is
            // a list of things to go and do first.
            if (err instanceof ApiError && err.status === 409) {
              setConfirmDelete(false);
              setBlockedBy(err.message);
              return;
            }
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
