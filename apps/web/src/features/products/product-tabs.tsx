import * as React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Plus, Trash2, Upload } from 'lucide-react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useToast } from '@/hooks/use-toast';
import {
  useAddProductImage,
  useDeleteProductImage,
  useProductImages,
  useProductStockLevel,
  useUploadProductImage,
} from './use-products';

/**
 * Image types the API accepts. Kept in step with ALLOWED_IMAGE_TYPES in
 * apps/api/src/modules/products/image-upload.routes.ts — this list only
 * filters the file picker and gives a better message; the API is what
 * actually enforces it.
 */
const ACCEPTED_IMAGE_TYPES = 'image/jpeg,image/png,image/webp,image/avif,image/gif';

/** Matches MAX_UPLOAD_BYTES on the API. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export function ProductImagesTab({ productId }: { productId: string }) {
  const { toast } = useToast();
  const { data: images, isLoading } = useProductImages(productId);
  const addMutation = useAddProductImage();
  const uploadMutation = useUploadProductImage();
  const deleteMutation = useDeleteProductImage();
  const [imageUrl, setImageUrl] = React.useState('');
  const [priority, setPriority] = React.useState(0);
  const [toDelete, setToDelete] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const failed = (title: string) => (err: unknown) =>
    toast({
      variant: 'destructive',
      title,
      description: err instanceof Error ? err.message : 'Unknown error',
    });

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    // Upload sequentially rather than in parallel: priority is assigned per
    // file and the order the operator picked them in is the order they should
    // appear in, which a race would scramble.
    let next = priority;
    let uploaded = 0;
    for (const file of Array.from(files)) {
      if (file.size > MAX_UPLOAD_BYTES) {
        failed('File too large')(
          new Error(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)}MB; the limit is 8MB.`),
        );
        continue;
      }
      try {
        await uploadMutation.mutateAsync({ productId, file, priority: next });
        next += 1;
        uploaded += 1;
      } catch (err) {
        failed(`Upload of ${file.name} failed`)(err);
      }
    }
    setPriority(next);
    // Let the same file be chosen again after a failure — without this the
    // input holds the old value and picking it a second time fires no event.
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (uploaded > 0) {
      toast({ title: uploaded === 1 ? 'Image uploaded' : `${uploaded} images uploaded` });
    }
  }

  const busy = addMutation.isPending || uploadMutation.isPending;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="space-y-2">
            <Label htmlFor="img-file">Upload from this computer</Label>
            <div className="flex items-center gap-3">
              <input
                ref={fileInputRef}
                id="img-file"
                type="file"
                className="sr-only"
                accept={ACCEPTED_IMAGE_TYPES}
                multiple
                onChange={(e) => void handleFiles(e.target.files)}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-4 w-4" />
                {uploadMutation.isPending ? 'Uploading…' : 'Choose file'}
              </Button>
              <p className="text-xs text-muted-foreground">
                JPEG, PNG, WebP, AVIF or GIF, up to 8MB each. Select several to add them in order.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs uppercase tracking-wider text-muted-foreground">or</span>
            <div className="h-px flex-1 bg-border" />
          </div>

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
                  failed('Add failed')(err);
                }
              }}
              disabled={!imageUrl || busy}
            >
              <Plus className="h-4 w-4" />
              Add image
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The first image by priority becomes the product&rsquo;s hero image on the storefront.
          </p>
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
