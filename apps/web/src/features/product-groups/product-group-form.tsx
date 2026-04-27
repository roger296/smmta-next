/**
 * Edit form for a single product group — full storefront content.
 * Used by /product-groups/$id. The /new route uses a slimmer create
 * form (just `name` + `description`) since the rich content is normally
 * filled in after the group exists.
 */
import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/forms/form-field';
import {
  buildChecklist,
  canPublishFromChecklist,
  CharCounter,
  ChecklistSummary,
  GalleryEditor,
  makeSlug,
  TagsInput,
} from './storefront-helpers';
import type { ProductGroup, Product } from '@/lib/api-types';

interface FormState {
  name: string;
  description: string;
  slug: string;
  shortDescription: string;
  longDescription: string;
  heroImageUrl: string;
  galleryImageUrls: string[];
  seoTitle: string;
  seoDescription: string;
  seoKeywords: string[];
  sortOrder: number;
  isPublished: boolean;
}

function fromGroup(g: ProductGroup): FormState {
  return {
    name: g.name,
    description: g.description ?? '',
    slug: g.slug ?? '',
    shortDescription: g.shortDescription ?? '',
    longDescription: g.longDescription ?? '',
    heroImageUrl: g.heroImageUrl ?? '',
    galleryImageUrls: g.galleryImageUrls ?? [],
    seoTitle: g.seoTitle ?? '',
    seoDescription: g.seoDescription ?? '',
    seoKeywords: g.seoKeywords ?? [],
    sortOrder: g.sortOrder ?? 0,
    isPublished: g.isPublished,
  };
}

export interface ProductGroupFormProps {
  group: ProductGroup;
  products?: Product[];
  onSubmit: (input: Partial<FormState>) => Promise<void>;
  isSaving?: boolean;
}

export function ProductGroupForm({ group, products, onSubmit, isSaving }: ProductGroupFormProps) {
  const [form, setForm] = React.useState<FormState>(() => fromGroup(group));
  React.useEffect(() => setForm(fromGroup(group)), [group]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((s) => ({ ...s, [key]: value }));

  const checklist = buildChecklist({
    slug: form.slug,
    shortDescription: form.shortDescription,
    heroImageUrl: form.heroImageUrl,
    longDescription: form.longDescription,
    galleryImageUrls: form.galleryImageUrls,
    seoTitle: form.seoTitle,
    seoDescription: form.seoDescription,
  });
  const canPublish = canPublishFromChecklist(checklist);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSubmit({
      name: form.name,
      description: form.description || undefined,
      slug: form.slug || undefined,
      shortDescription: form.shortDescription || undefined,
      longDescription: form.longDescription || undefined,
      heroImageUrl: form.heroImageUrl || undefined,
      galleryImageUrls: form.galleryImageUrls,
      seoTitle: form.seoTitle || undefined,
      seoDescription: form.seoDescription || undefined,
      seoKeywords: form.seoKeywords,
      sortOrder: form.sortOrder,
      isPublished: form.isPublished,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4" aria-label="Product group form">
      <Card>
        <CardHeader>
          <CardTitle>Publishing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ChecklistSummary items={checklist} />
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={form.isPublished}
              disabled={!canPublish && !form.isPublished}
              onCheckedChange={(c) => set('isPublished', c === true)}
            />
            <span>
              <span className="font-medium">Published</span> — appears on the public store.
              {!canPublish && !form.isPublished && (
                <span className="ml-1 text-xs text-[var(--color-destructive)]">
                  (Complete the required checklist items first.)
                </span>
              )}
            </span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Basics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field id="g-name" label="Name" required>
            <Input
              id="g-name"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              maxLength={200}
              required
            />
          </Field>
          <Field id="g-description" label="Internal description">
            <Textarea
              id="g-description"
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              rows={2}
              placeholder="Operator-only notes about this group."
            />
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field id="g-slug" label="URL slug">
              <div className="flex gap-2">
                <Input
                  id="g-slug"
                  value={form.slug}
                  onChange={(e) => set('slug', e.target.value)}
                  placeholder="aurora-range"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => set('slug', makeSlug(form.name))}
                >
                  Auto-generate
                </Button>
              </div>
            </Field>
            <Field id="g-sort" label="Sort order">
              <Input
                id="g-sort"
                type="number"
                min={0}
                value={form.sortOrder}
                onChange={(e) => set('sortOrder', Number(e.target.value) || 0)}
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Storefront content</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="g-short">Short description</Label>
              <CharCounter value={form.shortDescription} max={280} />
            </div>
            <Textarea
              id="g-short"
              value={form.shortDescription}
              onChange={(e) => set('shortDescription', e.target.value)}
              maxLength={280}
              rows={2}
            />
          </div>

          <Field id="g-long" label="Long description (supports Markdown)">
            <Textarea
              id="g-long"
              value={form.longDescription}
              onChange={(e) => set('longDescription', e.target.value)}
              rows={8}
            />
          </Field>

          <Field id="g-hero" label="Hero image URL">
            <Input
              id="g-hero"
              value={form.heroImageUrl}
              onChange={(e) => set('heroImageUrl', e.target.value)}
              placeholder="https://cdn.example.com/hero.jpg"
              type="url"
            />
          </Field>

          <Field id="g-gallery" label="Gallery images">
            <GalleryEditor
              value={form.galleryImageUrls}
              onChange={(next) => set('galleryImageUrls', next)}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>SEO</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="g-seo-title">SEO title</Label>
              <CharCounter value={form.seoTitle} max={70} />
            </div>
            <Input
              id="g-seo-title"
              value={form.seoTitle}
              onChange={(e) => set('seoTitle', e.target.value)}
              maxLength={70}
              placeholder={form.name}
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="g-seo-desc">SEO description</Label>
              <CharCounter value={form.seoDescription} max={160} />
            </div>
            <Textarea
              id="g-seo-desc"
              value={form.seoDescription}
              onChange={(e) => set('seoDescription', e.target.value)}
              maxLength={160}
              rows={2}
            />
          </div>
          <Field id="g-seo-keywords" label="SEO keywords">
            <TagsInput
              id="g-seo-keywords"
              value={form.seoKeywords}
              onChange={(next) => set('seoKeywords', next)}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Storefront preview</CardTitle>
        </CardHeader>
        <CardContent>
          <ProductGroupPreviewTile
            name={form.name}
            heroImageUrl={form.heroImageUrl}
            shortDescription={form.shortDescription}
            products={products ?? []}
          />
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" disabled={!!isSaving}>
          {isSaving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Preview tile — what the group will look like on /shop in the storefront.
// ---------------------------------------------------------------------------

function ProductGroupPreviewTile({
  name,
  heroImageUrl,
  shortDescription,
  products,
}: {
  name: string;
  heroImageUrl: string;
  shortDescription: string;
  products: Product[];
}) {
  const prices = products
    .map((p) => (p.minSellingPrice ? Number.parseFloat(p.minSellingPrice) : null))
    .filter((p): p is number => p !== null);
  const priceRange =
    prices.length > 0
      ? prices.length === 1 || Math.min(...prices) === Math.max(...prices)
        ? `£${prices[0]!.toFixed(2)}`
        : `£${Math.min(...prices).toFixed(2)} – £${Math.max(...prices).toFixed(2)}`
      : '—';
  return (
    <div
      data-testid="group-preview-tile"
      className="max-w-sm overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-card)]"
    >
      <div className="aspect-square w-full bg-[var(--color-muted)]">
        {heroImageUrl ? (
          <img src={heroImageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-[var(--color-muted-foreground)]">
            No hero image
          </div>
        )}
      </div>
      <div className="p-4">
        <h3 className="font-medium">{name || 'Untitled group'}</h3>
        {shortDescription && (
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)] line-clamp-2">
            {shortDescription}
          </p>
        )}
        <p className="mt-2 text-sm font-medium">From {priceRange}</p>
        <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
          {products.length} variant{products.length === 1 ? '' : 's'}
        </p>
      </div>
    </div>
  );
}
