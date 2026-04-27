/**
 * Storefront tab for the product editor — Prompt 6.
 *
 * Saves storefront-specific fields (group_id, colour, slug, hero/gallery,
 * SEO, sort order, is_published) via the existing `useUpdateProduct`
 * mutation. Operational fields (price, stock code, etc.) live on the
 * General tab and aren't touched here.
 *
 * The publish toggle is gated by `buildChecklist`: if `slug`,
 * `short_description`, or `hero_image_url` are missing, `is_published`
 * cannot be turned on.
 */
import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/forms/form-field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useUpdateProduct } from './use-products';
import { useProductGroupsList } from '../product-groups/use-product-groups';
import {
  buildChecklist,
  canPublishFromChecklist,
  CharCounter,
  ChecklistSummary,
  GalleryEditor,
  makeSlug,
  TagsInput,
} from '../product-groups/storefront-helpers';
import type { Product } from '@/lib/api-types';

const STANDALONE = '__standalone__';

interface FormState {
  groupId: string | null;
  colour: string;
  colourHex: string;
  slug: string;
  shortDescription: string;
  longDescription: string;
  heroImageUrl: string;
  galleryImageUrls: string[];
  seoTitle: string;
  seoDescription: string;
  seoKeywords: string[];
  sortOrderInGroup: number;
  isPublished: boolean;
}

function fromProduct(p: Product): FormState {
  return {
    groupId: p.groupId,
    colour: p.colour ?? '',
    colourHex: p.colourHex ?? '',
    slug: p.slug ?? '',
    shortDescription: p.shortDescription ?? '',
    longDescription: p.longDescription ?? '',
    heroImageUrl: p.heroImageUrl ?? '',
    galleryImageUrls: p.galleryImageUrls ?? [],
    seoTitle: p.seoTitle ?? '',
    seoDescription: p.seoDescription ?? '',
    seoKeywords: p.seoKeywords ?? [],
    sortOrderInGroup: p.sortOrderInGroup ?? 0,
    isPublished: p.isPublished,
  };
}

export function StorefrontTab({ product }: { product: Product }) {
  const { toast } = useToast();
  const update = useUpdateProduct();
  const { data: groups, isLoading: groupsLoading } = useProductGroupsList();

  const [form, setForm] = React.useState<FormState>(() => fromProduct(product));

  // If the upstream product changes (e.g. after a save), reset.
  React.useEffect(() => {
    setForm(fromProduct(product));
  }, [product]);

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
    try {
      await update.mutateAsync({
        id: product.id,
        input: {
          groupId: form.groupId,
          colour: form.colour || null,
          colourHex: form.colourHex || null,
          slug: form.slug || null,
          shortDescription: form.shortDescription || null,
          longDescription: form.longDescription || null,
          heroImageUrl: form.heroImageUrl || null,
          galleryImageUrls: form.galleryImageUrls.length > 0 ? form.galleryImageUrls : null,
          seoTitle: form.seoTitle || null,
          seoDescription: form.seoDescription || null,
          seoKeywords: form.seoKeywords.length > 0 ? form.seoKeywords : null,
          sortOrderInGroup: form.sortOrderInGroup,
          isPublished: form.isPublished,
        },
      });
      toast({ title: 'Storefront content saved' });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Save failed',
        description: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4" aria-label="Storefront tab">
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
          <CardTitle>Group + colour</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sf-group">Product group</Label>
            <div className="flex gap-2">
              <Select
                value={form.groupId ?? STANDALONE}
                onValueChange={(v) => set('groupId', v === STANDALONE ? null : v)}
              >
                <SelectTrigger id="sf-group" className="flex-1">
                  <SelectValue
                    placeholder={groupsLoading ? 'Loading groups…' : 'Select group'}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={STANDALONE}>Standalone (no group)</SelectItem>
                  {groups?.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button asChild type="button" variant="outline" size="sm">
                <Link to="/product-groups/new">Create new group</Link>
              </Button>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field id="sf-colour" label="Colour name">
              <Input
                id="sf-colour"
                value={form.colour}
                onChange={(e) => set('colour', e.target.value)}
                placeholder="e.g. Smoke"
                maxLength={80}
              />
            </Field>
            <div className="space-y-1.5">
              <Label htmlFor="sf-colour-hex">Colour swatch (#RRGGBB)</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="sf-colour-hex"
                  value={form.colourHex}
                  onChange={(e) => set('colourHex', e.target.value)}
                  placeholder="#3a3a3a"
                  maxLength={7}
                  pattern="#[0-9a-fA-F]{6}"
                />
                <span
                  data-testid="colour-swatch"
                  aria-label="Colour preview"
                  className="h-8 w-8 flex-shrink-0 rounded border border-[var(--color-border)]"
                  style={{ backgroundColor: form.colourHex || 'transparent' }}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Storefront content</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sf-slug">URL slug</Label>
            <div className="flex gap-2">
              <Input
                id="sf-slug"
                value={form.slug}
                onChange={(e) => set('slug', e.target.value)}
                placeholder="my-product-colour"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => set('slug', makeSlug(product.name, form.colour))}
              >
                Auto-generate
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="sf-short">Short description</Label>
              <CharCounter value={form.shortDescription} max={280} />
            </div>
            <Textarea
              id="sf-short"
              value={form.shortDescription}
              onChange={(e) => set('shortDescription', e.target.value)}
              maxLength={280}
              rows={2}
              placeholder="One-line tagline. Shown on listing cards."
            />
          </div>

          <Field
            id="sf-long"
            label="Long description (supports Markdown)"
          >
            <Textarea
              id="sf-long"
              value={form.longDescription}
              onChange={(e) => set('longDescription', e.target.value)}
              rows={8}
              placeholder="Use **bold**, _italic_, and headings as you like."
            />
          </Field>

          <Field id="sf-hero" label="Hero image URL">
            <Input
              id="sf-hero"
              value={form.heroImageUrl}
              onChange={(e) => set('heroImageUrl', e.target.value)}
              placeholder="https://cdn.example.com/hero.jpg"
              type="url"
            />
          </Field>

          <Field id="sf-gallery" label="Gallery images">
            <GalleryEditor
              value={form.galleryImageUrls}
              onChange={(next) => set('galleryImageUrls', next)}
            />
          </Field>

          <Field id="sf-sort" label="Sort order in group">
            <Input
              id="sf-sort"
              type="number"
              min={0}
              value={form.sortOrderInGroup}
              onChange={(e) => set('sortOrderInGroup', Number(e.target.value) || 0)}
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
              <Label htmlFor="sf-seo-title">SEO title</Label>
              <CharCounter value={form.seoTitle} max={70} />
            </div>
            <Input
              id="sf-seo-title"
              value={form.seoTitle}
              onChange={(e) => set('seoTitle', e.target.value)}
              maxLength={70}
              placeholder={product.name}
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="sf-seo-desc">SEO description</Label>
              <CharCounter value={form.seoDescription} max={160} />
            </div>
            <Textarea
              id="sf-seo-desc"
              value={form.seoDescription}
              onChange={(e) => set('seoDescription', e.target.value)}
              maxLength={160}
              rows={2}
            />
          </div>

          <Field id="sf-seo-keywords" label="SEO keywords">
            <TagsInput
              id="sf-seo-keywords"
              value={form.seoKeywords}
              onChange={(next) => set('seoKeywords', next)}
              placeholder="Type a keyword and press Enter"
            />
          </Field>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save storefront content'}
        </Button>
      </div>
    </form>
  );
}
