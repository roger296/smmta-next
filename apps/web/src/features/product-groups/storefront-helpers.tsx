/**
 * Small UI helpers shared by the product Storefront tab and the
 * product-group editor: slug generator, chip / tags input, image-list
 * editor with up/down sort, and a publish-readiness checklist.
 *
 * v1 simplifications (documented in the Prompt 6 PR):
 *   - long_description is a textarea with a "supports markdown" caption,
 *     not a live-preview markdown editor. The Drizzle field is markdown
 *     either way; the storefront renders it.
 *   - gallery uses up/down arrow buttons rather than HTML5 drag-to-sort.
 *   - hero_image_url is a URL input. The architecture's image-upload
 *     surface lands later; until then operators paste hosted URLs.
 */
import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';

/** Lower-case, kebab-case, ASCII-only slug. */
export function makeSlug(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' ')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

// ---------------------------------------------------------------------------
// Char counter helper
// ---------------------------------------------------------------------------

export function CharCounter({
  value,
  max,
}: {
  value: string | null | undefined;
  max: number;
}) {
  const length = value?.length ?? 0;
  const over = length > max;
  return (
    <span
      className={`text-xs ${
        over ? 'text-[var(--color-destructive)]' : 'text-[var(--color-muted-foreground)]'
      }`}
      aria-live="polite"
    >
      {length} / {max}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tags / chips input — used for SEO keywords. Enter or comma adds a tag.
// ---------------------------------------------------------------------------

export interface TagsInputProps {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  maxTags?: number;
}

export function TagsInput({ id, value, onChange, placeholder, maxTags = 30 }: TagsInputProps) {
  const [draft, setDraft] = React.useState('');
  const commit = () => {
    const v = draft.trim();
    if (!v) return;
    if (value.includes(v)) {
      setDraft('');
      return;
    }
    if (value.length >= maxTags) return;
    onChange([...value, v]);
    setDraft('');
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {value.map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1 pr-1">
            <span>{tag}</span>
            <button
              type="button"
              aria-label={`Remove ${tag}`}
              className="rounded-sm p-0.5 hover:bg-[var(--color-muted)]"
              onClick={() => onChange(value.filter((t) => t !== tag))}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      <Input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Backspace' && draft === '' && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={placeholder ?? 'Type a keyword and press Enter'}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gallery editor — list of URLs with up/down/remove buttons.
// ---------------------------------------------------------------------------

export interface GalleryEditorProps {
  value: string[];
  onChange: (next: string[]) => void;
}

export function GalleryEditor({ value, onChange }: GalleryEditorProps) {
  const [draft, setDraft] = React.useState('');
  const move = (idx: number, dir: -1 | 1) => {
    const next = [...value];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    const tmp = next[idx]!;
    next[idx] = next[target]!;
    next[target] = tmp;
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          aria-label="New gallery image URL"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="https://cdn.example.com/image.jpg"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            if (!draft.trim()) return;
            onChange([...value, draft.trim()]);
            setDraft('');
          }}
        >
          <Plus className="h-4 w-4" />
          Add
        </Button>
      </div>
      {value.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No gallery images yet.</p>
      ) : (
        <ul className="space-y-2">
          {value.map((url, idx) => (
            <li
              key={`${url}-${idx}`}
              className="flex items-center gap-2 rounded border border-[var(--color-border)] p-2"
            >
              <img
                src={url}
                alt=""
                className="h-12 w-12 flex-shrink-0 rounded object-cover"
              />
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-muted-foreground)]">
                {url}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Move up"
                disabled={idx === 0}
                onClick={() => move(idx, -1)}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Move down"
                disabled={idx === value.length - 1}
                onClick={() => move(idx, 1)}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove image"
                onClick={() => onChange(value.filter((_, i) => i !== idx))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Publish checklist — what's complete vs. what's missing.
// ---------------------------------------------------------------------------

export interface ChecklistItem {
  id: string;
  label: string;
  /** True when the field is "complete enough" to count toward the score. */
  complete: boolean;
  /** True when the field is required to publish (publish blocked otherwise). */
  requiredToPublish: boolean;
}

/** Compute the standard 7-item storefront checklist for a record.
 *  The 3 items with `requiredToPublish: true` gate the publish toggle. */
export function buildChecklist(input: {
  slug: string | null | undefined;
  shortDescription: string | null | undefined;
  heroImageUrl: string | null | undefined;
  longDescription?: string | null | undefined;
  galleryImageUrls?: string[] | null | undefined;
  seoTitle?: string | null | undefined;
  seoDescription?: string | null | undefined;
}): ChecklistItem[] {
  return [
    {
      id: 'slug',
      label: 'URL slug',
      complete: !!input.slug && input.slug.trim().length > 0,
      requiredToPublish: true,
    },
    {
      id: 'short_description',
      label: 'Short description',
      complete: !!input.shortDescription && input.shortDescription.trim().length > 0,
      requiredToPublish: true,
    },
    {
      id: 'hero_image_url',
      label: 'Hero image',
      complete: !!input.heroImageUrl && input.heroImageUrl.trim().length > 0,
      requiredToPublish: true,
    },
    {
      id: 'long_description',
      label: 'Long description',
      complete: !!input.longDescription && input.longDescription.trim().length > 0,
      requiredToPublish: false,
    },
    {
      id: 'gallery_image_urls',
      label: 'Gallery images',
      complete: Array.isArray(input.galleryImageUrls) && input.galleryImageUrls.length > 0,
      requiredToPublish: false,
    },
    {
      id: 'seo_title',
      label: 'SEO title',
      complete: !!input.seoTitle && input.seoTitle.trim().length > 0,
      requiredToPublish: false,
    },
    {
      id: 'seo_description',
      label: 'SEO description',
      complete: !!input.seoDescription && input.seoDescription.trim().length > 0,
      requiredToPublish: false,
    },
  ];
}

export function canPublishFromChecklist(items: ChecklistItem[]): boolean {
  return items.every((i) => !i.requiredToPublish || i.complete);
}

export function ChecklistSummary({ items }: { items: ChecklistItem[] }) {
  const complete = items.filter((i) => i.complete).length;
  const total = items.length;
  const missingRequired = items.filter((i) => i.requiredToPublish && !i.complete);
  return (
    <div
      data-testid="storefront-checklist"
      className="rounded border border-[var(--color-border)] bg-[var(--color-muted)] p-3"
    >
      <p className="font-medium">
        {complete} of {total} storefront fields complete
      </p>
      {missingRequired.length > 0 && (
        <p className="mt-1 text-xs text-[var(--color-destructive)]">
          Missing required: {missingRequired.map((i) => i.label).join(', ')}
        </p>
      )}
      <ul className="mt-2 space-y-0.5 text-xs">
        {items.map((i) => (
          <li
            key={i.id}
            className={i.complete ? 'text-[var(--color-foreground)]' : 'text-[var(--color-muted-foreground)]'}
          >
            <span aria-hidden="true">{i.complete ? '✓' : '○'}</span>{' '}
            {i.label}
            {i.requiredToPublish && !i.complete && (
              <span className="ml-1 text-[var(--color-destructive)]">(required to publish)</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
