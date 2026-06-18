import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Images } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/empty-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatDateTime } from '@/lib/format';
import { useSites } from '@/features/sites/use-sites';
import { useImageGallery, type ImageCaptureSource } from '@/features/images/use-images';

export const Route = createFileRoute('/_authed/gallery')({
  component: GalleryPage,
});

const SOURCES: ImageCaptureSource[] = ['REFERENCE', 'GOODS_IN', 'STOCK_TAKE', 'CONSUMPTION', 'SHELF'];

function GalleryPage() {
  const { data: sites } = useSites();
  const [siteId, setSiteId] = React.useState('ALL');
  const [source, setSource] = React.useState('ALL');
  const gallery = useImageGallery({
    siteId: siteId === 'ALL' ? undefined : siteId,
    source: source === 'ALL' ? undefined : (source as ImageCaptureSource),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Image gallery</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          The accumulating labelled image set — product reference photos plus goods-in, stock-take
          and consumption captures, keyed by SKU + site + time. Groundwork for future AI item
          recognition; no model runs today.
        </p>
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="w-56 space-y-1.5">
          <Label>Site</Label>
          <Select value={siteId} onValueChange={setSiteId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All sites</SelectItem>
              {(sites ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-56 space-y-1.5">
          <Label>Source</Label>
          <Select value={source} onValueChange={setSource}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All sources</SelectItem>
              {SOURCES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {gallery.data && gallery.data.length === 0 && (
        <EmptyState
          icon={Images}
          title="No captures yet"
          description="Reference photos and capture images appear here as they're taken."
        />
      )}

      {gallery.data && gallery.data.length > 0 && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {gallery.data.map((img) => (
            <Card key={img.id}>
              <CardContent className="space-y-2 p-3">
                <div className="aspect-square overflow-hidden rounded-md bg-[var(--color-muted)]">
                  <img src={img.imageRef} alt={img.label ?? img.source} className="h-full w-full object-cover" loading="lazy" />
                </div>
                <div className="flex items-center justify-between">
                  <Badge variant="secondary">{img.source}</Badge>
                  <span className="text-xs text-[var(--color-muted-foreground)]">{formatDateTime(img.capturedAt)}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
