import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/forms/form-field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plus } from 'lucide-react';
import { useCreateItemCategory, useItemCategories } from './use-item-categories';

/** The sentinel the "add a new one" row carries. Not a uuid, so it can't collide. */
const ADD_NEW = '__add_new__';
/** The sentinel for "no category". Radix Select forbids an empty-string value. */
const NONE = '__none__';

interface Props {
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

/**
 * Item category picker, with "Add a new category…" built into the list.
 *
 * The request was an enum the user can extend, so adding one cannot be a trip
 * to a different screen — by the time you are filling in a product you have
 * already found the category missing. Choosing the add row swaps the select for
 * a text box; the new category is created, selected and in the list for every
 * other product without a reload.
 */
export function ItemCategoryField({ value, onChange, error }: Props) {
  const { data: categories, isLoading } = useItemCategories();
  const create = useCreateItemCategory();
  const [adding, setAdding] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  async function commit() {
    const name = draft.trim();
    if (!name) return;
    const created = await create.mutateAsync(name);
    onChange(created.id);
    setDraft('');
    setAdding(false);
  }

  if (adding) {
    return (
      <Field
        id="p-itemCategory-new"
        label="New item category"
        hint="It will be available on every product once saved."
        error={create.error instanceof Error ? create.error.message : error}
      >
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            value={draft}
            maxLength={100}
            placeholder="Dry Stock"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter must not submit the product form — this is a nested
              // action, and saving a half-filled product would be a surprise.
              if (e.key === 'Enter') {
                e.preventDefault();
                void commit();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setAdding(false);
              }
            }}
            aria-label="New item category name"
          />
          <Button
            type="button"
            onClick={() => void commit()}
            disabled={!draft.trim() || create.isPending}
          >
            {create.isPending ? 'Adding…' : 'Add'}
          </Button>
          <Button type="button" variant="outline" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </div>
      </Field>
    );
  }

  return (
    <Field
      id="p-itemCategory"
      label="Item category"
      hint="Your own classification of this item. Add one if the list is missing it."
      error={error}
    >
      <Select
        value={value || NONE}
        onValueChange={(v) => {
          if (v === ADD_NEW) {
            setAdding(true);
            return;
          }
          onChange(v === NONE ? '' : v);
        }}
      >
        <SelectTrigger aria-label="Item category">
          <SelectValue placeholder={isLoading ? 'Loading…' : 'No category'} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>No category</SelectItem>
          {categories?.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
          <SelectItem value={ADD_NEW}>
            <span className="flex items-center gap-2">
              <Plus className="h-3.5 w-3.5" />
              Add a new category…
            </span>
          </SelectItem>
        </SelectContent>
      </Select>
    </Field>
  );
}
