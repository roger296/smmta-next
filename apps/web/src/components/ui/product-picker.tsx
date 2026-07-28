import * as React from 'react';
import { Input } from '@/components/ui/input';
import { useProduct, useProductsList } from '@/features/products/use-products';
import { cn } from '@/lib/utils';
import { Check, ChevronDown, Loader2, X } from 'lucide-react';

/**
 * Type-to-search product picker.
 *
 * Replaces a plain <Select> that rendered the entire catalogue. That was fine
 * at 60 products and unusable at 527: the list took a visible pause to open,
 * and finding "Long Life Semi Skimmed Milk" meant scrolling past four hundred
 * things that were not it.
 *
 * The search runs on the SERVER (name, stock code and EAN), so it cannot be
 * outgrown by the catalogue the way a fixed page size can — which is exactly
 * how the head-baker form quietly broke when the catalogue passed 500.
 */
export interface ProductPickerProps {
  value: string;
  onChange: (productId: string) => void;
  placeholder?: string;
  /** Rendered when nothing is selected and the field is untouched. */
  id?: string;
  disabled?: boolean;
  /** Restrict what can be picked. Recipes pass INGREDIENT + PACKAGING so a
   *  bottle of bleach cannot be added to a cake. Filtering happens on the
   *  SERVER — filtering a search page afterwards would silently return fewer
   *  results than asked for, or none at all. */
  itemKind?: Array<'MERCH' | 'RETAIL' | 'INGREDIENT' | 'PACKAGING'>;
}

const DEBOUNCE_MS = 200;
const PAGE_SIZE = 20;

export function ProductPicker({
  value,
  onChange,
  placeholder = 'Search ingredients…',
  id,
  disabled,
  itemKind,
}: ProductPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [term, setTerm] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [highlight, setHighlight] = React.useState(0);
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(term), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [term]);

  // A short page: this is a picker, not a browser. Anything not in the first
  // twenty wants a better search term, not more scrolling.
  const { data, isFetching } = useProductsList({
    pageSize: PAGE_SIZE,
    search: debounced || undefined,
    itemKind,
  });
  const results = React.useMemo(() => data?.data ?? [], [data]);

  // The selected product is usually NOT in the current search results — the
  // whole point is that the list is a short, filtered window. Fetch it by id
  // rather than hoping it happens to be on screen.
  const { data: selectedById, isError: selectedMissing } = useProduct(value || undefined);
  const selected = results.find((p) => p.id === value) ?? selectedById;
  // A recipe can outlive an ingredient someone deleted from the catalogue.
  // Left alone the field renders blank and the line looks like an empty row
  // nobody filled in — say what happened instead.
  const orphaned = !!value && !selected && selectedMissing;

  React.useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  React.useEffect(() => setHighlight(0), [debounced]);

  const choose = (productId: string) => {
    onChange(productId);
    setOpen(false);
    setTerm('');
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return setOpen(true);
      setHighlight((h) => {
        const next = e.key === 'ArrowDown' ? h + 1 : h - 1;
        return Math.max(0, Math.min(results.length - 1, next));
      });
      return;
    }
    if (e.key === 'Enter' && open && results[highlight]) {
      e.preventDefault();
      choose(results[highlight]!.id);
      return;
    }
    if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <Input
          id={id}
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          // Showing the selection as the placeholder means the field reads as
          // chosen while still being immediately typeable to change it.
          placeholder={
            selected
              ? `${selected.name} (${selected.stockUom})`
              : orphaned
                ? 'Deleted product — pick a replacement'
                : placeholder
          }
          className={cn(
            selected && !term && 'placeholder:text-[var(--color-foreground)]',
            orphaned && 'border-[var(--color-destructive)] placeholder:text-[var(--color-destructive)]',
          )}
          value={term}
          onChange={(e) => {
            setTerm(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-1">
          {isFetching && open && (
            <Loader2 className="h-4 w-4 animate-spin text-[var(--color-muted-foreground)]" />
          )}
          {selected && !term ? (
            <button
              type="button"
              aria-label="Clear ingredient"
              className="pointer-events-auto rounded p-0.5 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
              onClick={() => choose('')}
            >
              <X className="h-4 w-4" />
            </button>
          ) : (
            <ChevronDown className="h-4 w-4 text-[var(--color-muted-foreground)]" />
          )}
        </div>
      </div>

      {open && (
        <ul
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-popover)] py-1 shadow-lg"
        >
          {results.length === 0 && (
            <li className="px-3 py-2 text-sm text-[var(--color-muted-foreground)]">
              {isFetching
                ? 'Searching…'
                : debounced
                  ? `No ingredient matches “${debounced}”.`
                  : 'Start typing to search the catalogue.'}
            </li>
          )}
          {results.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                role="option"
                aria-selected={p.id === value}
                className={cn(
                  'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm',
                  i === highlight
                    ? 'bg-[var(--color-accent)] text-[var(--color-accent-foreground)]'
                    : 'hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-foreground)]',
                )}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => choose(p.id)}
              >
                <span className="truncate">
                  {p.name}{' '}
                  <span className="text-[var(--color-muted-foreground)]">({p.stockUom})</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {/* Names repeat across the catalogue — the stock code is what
                      tells two similar ingredients apart. */}
                  <span className="font-mono text-xs text-[var(--color-muted-foreground)]">
                    {p.stockCode}
                  </span>
                  {p.id === value && <Check className="h-4 w-4" />}
                </span>
              </button>
            </li>
          ))}
          {results.length === PAGE_SIZE && (
            <li className="border-t border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-muted-foreground)]">
              Showing the first {PAGE_SIZE} matches — keep typing to narrow it down.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
