import * as React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Plus, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useToast } from '@/hooks/use-toast';
import {
  useAddProductImage,
  useDeleteProductImage,
  useProductImages,
  useProductStockLevel,
} from './use-products';

export function ProductImagesTab({ productId }: { productId: string }) {
  const { toast } = useToast();
  const { data: images, isLoading } = useProductImages(productId);
  const addMutation = useAddProductImage();
  const deleteMutation = useDeleteProductImage();
  const [imageUrl, setImageUrl] = React.useState('');
  const [priority, setPriority] = React.useState(0);
  const [toDelete, setToDelete] = React.useState<string | null>(null);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="grid gap-3 md:grid-cols-[1fr_120px]">
            <div className="space-y-1">
              <Label htmlFor="img-url">Image URL</Label>
              <Input
                id="img-url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="https://cdn.example.com/image.jpg"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="img-priority">Priority</Label>
              <Input
                id="img-priority"
                type="number"
                min={0}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await addMutation.mutateAsync({
                    productId,
                    input: { imageUrl, priority },
                  });
                  toast({ title: 'Image added' });
                  setImageUrl('');
                  setPriority(0);
                } catch (err) {
                  toast({
                    variant: 'destructive',
                    title: 'Add failed',
                    description: err instanceof Error ? err.message : 'Unknown error',
                  });
                }
              }}
              disabled={!imageUrl || addMutation.isPending}
            >
              <Plus className="h-4 w-4" />
              Add image
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading && <Skeleton className="h-32 w-full" />}
      {images && images.length === 0 && (
        <p className="text-sm text-[var(--color-muted-foreground)]">No images yet.</p>
      )}
      {images && images.length > 0 && (
        <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-4">
          {images.map((img) => (
            <Card key={img.id}>
              <CardContent className="p-2">
                <img
                  src={img.imageUrl}
                  alt=""
                  className="aspect-square w-full rounded object-cover"
                />
                <div className="flex items-center justify-between pt-2">
                  <span className="text-xs text-[var(--color-muted-foreground)]">
                    Priority {img.priority}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Delete image"
                    onClick={() => setToDelete(img.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete image?"
        destructive
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!toDelete) return;
          await deleteMutation.mutateAsync({ productId, imageId: toDelete });
          toast({ title: 'Image deleted' });
          setToDelete(null);
        }}
      />
    </div>
  );
}

export function ProductStockTab({ productId }: { productId: string }) {
  const { data, isLoading } = useProductStockLevel(productId);
  if (isLoading) return <Skeleton className="h-32 w-full" />;
  if (!data || data.length === 0)
    return (
      <p className="text-sm text-[var(--color-muted-foreground)]">No stock yet in any warehouse.</p>
    );
  return (
    <Card>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Warehouse</th>
              <th className="px-4 py-2 text-right font-medium">Available</th>
              <th className="px-4 py-2 text-right font-medium">Allocated</th>
              <th className="px-4 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.map((level) => (
              <tr
                key={level.warehouseId}
                className="border-b border-[var(--color-border)] last:border-b-0"
              >
                <td className="px-4 py-2">{level.warehouseName}</td>
                <td className="px-4 py-2 text-right">{level.available}</td>
                <td className="px-4 py-2 text-right">{level.allocated}</td>
                <td className="px-4 py-2 text-right font-medium">{level.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
