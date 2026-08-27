/**
 * Type-to-search entity picker.
 *
 * Replaces the plain <Select> that used to back product / customer / supplier
 * fields. Those loaded the whole list up front and rendered every row, which
 * does not survive a real catalogue — this deployment already carries 129
 * variants and a drop-shipped range runs to six figures. The stock-adjust page
 * asked for 500 rows at once, the API caps a page at 250, and the resulting 400
 * left the operator staring at an empty dropdown with no error shown.
 *
 * So the caller searches server-side and passes back a short list. This
 * component owns the input, the debounce, keyboard navigation and the ARIA
 * wiring, and knows nothing about what it is picking.
 *
 * Presentational by design — no data fetching here. See entity-pickers.tsx.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useDebouncedValue } from '@/hooks/use-debounced-value';

export interface ComboboxOption {
  id: string;
  /** Primary line — the product name, customer name, etc. */
  label: string;
  /** Secondary line, shown dimmer. The SKU, email, account code. */
  sublabel?: string | null;
}

export interface EntityComboboxProps {
  /** Currently selected id, or undefined. */
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  /** Options to offer, already narrowed by the caller's search. */
  options: ComboboxOption[];
  /** Called (debounced) when the typed term changes. */
  onSearchTermChange: (term: string) => void;
  /**
   * Label for the current value. Needed because the selected row is often
   * absent from the current search results — an edit form opens with an id and
   * an empty search, and without this the field would look blank.
   */
  selectedLabel?: string | null;
  isLoading?: boolean;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

/**
 * How many rows to show. Deliberately small: a picker is for finding a known
 * item, not for browsing — that is what the list pages are for.
 */
export const MAX_VISIBLE_OPTIONS = 10;

export function EntityCombobox({
  value,
  onChange,
  options,
  onSearchTermChange,
  selectedLabel,
  isLoading = false,
  placeholder = 'Search...',
  id,
  disabled = false,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: EntityComboboxProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const listboxId = `${inputId}-listbox`;

  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const debouncedTerm = useDebouncedValue(term, 250);
  useEffect(() => {
    onSearchTermChange(debouncedTerm);
    // onSearchTermChange is expected to be stable (useCallback in the wrapper);
    // depending on it directly would re-fire on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedTerm]);

  const visible = useMemo(() => options.slice(0, MAX_VISIBLE_OPTIONS), [options]);

  // Keep the highlight in range when the result set shrinks under the cursor.
  useEffect(() => {
    setActiveIndex((i) => (i >= visible.length ? 0 : i));
  }, [visible.length]);

  // Close when a pointer lands outside the widget.
  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: MouseEvent | TouchEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocPointerDown);
    document.addEventListener('touchstart', onDocPointerDown);
    return () => {
      document.removeEventListener('mousedown', onDocPointerDown);
      document.removeEventListener('touchstart', onDocPointerDown);
    };
  }, [open]);

  function select(option: ComboboxOption) {
    onChange(option.id);
    setOpen(false);
    setTerm('');
  }

  function clear() {
    onChange(undefined);
    setTerm('');
    setOpen(true);
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (visible.length === 0) return;
      setActiveIndex((i) =>
        e.key === 'ArrowDown' ? (i + 1) % visible.length : (i - 1 + visible.length) % visible.length,
      );
      return;
    }
    if (e.key === 'Enter') {
      // Only swallow Enter while actually choosing, so the key still submits
      // the surrounding form when the list is closed.
      if (open && visible[activeIndex]) {
        e.preventDefault();
        select(visible[activeIndex]);
      }
      return;
    }
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (e.key === 'Tab') setOpen(false);
  }

  // With something selected and no active typing, show the selection rather
  // than an empty box.
  const showingSelection = Boolean(value) && term === '';
  const inputValue = showingSelection ? (selectedLabel ?? '') : term;

  return (
    <div ref={rootRef} className="relative">
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && visible[activeIndex] ? `${listboxId}-opt-${visible[activeIndex].id}` : undefined
          }
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedBy}
          disabled={disabled}
          placeholder={placeholder}
          value={inputValue}
          onChange={(e) => {
            setTerm(e.target.value);
            setOpen(true);
            // Typing over a selection means it is being replaced; leaving the
            // old id set would silently submit the wrong entity.
            if (value) onChange(undefined);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className={cn(
            'flex h-10 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-1',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        />
        {value && !disabled && (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear selection"
            className="shrink-0 rounded-md border border-[var(--color-border)] px-2 py-2 text-xs hover:bg-[var(--color-muted)]"
          >
            &times;
          </button>
        )}
      </div>

      {open && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-background)] py-1 shadow-md"
        >
          {isLoading && (
            <li className="px-3 py-2 text-sm text-[var(--color-muted-foreground)]">Searching...</li>
          )}

          {!isLoading && visible.length === 0 && (
            <li className="px-3 py-2 text-sm text-[var(--color-muted-foreground)]">
              {term.trim() === '' ? 'Type to search' : `No matches for "${term}"`}
            </li>
          )}

          {!isLoading &&
            visible.map((o, i) => (
              <li
                key={o.id}
                id={`${listboxId}-opt-${o.id}`}
                role="option"
                aria-selected={o.id === value}
                // Pointer-down rather than click: the input's blur would
                // otherwise close the list before a click could land.
                onMouseDown={(e) => {
                  e.preventDefault();
                  select(o);
                }}
                onMouseEnter={() => setActiveIndex(i)}
                className={cn(
                  'cursor-pointer px-3 py-2 text-sm',
                  i === activeIndex && 'bg-[var(--color-muted)]',
                )}
              >
                <div className="truncate">{o.label}</div>
                {o.sublabel && (
                  <div className="truncate text-xs text-[var(--color-muted-foreground)]">
                    {o.sublabel}
                  </div>
                )}
              </li>
            ))}

          {!isLoading && options.length > MAX_VISIBLE_OPTIONS && (
            // Say so, rather than implying these are all the matches.
            <li className="border-t border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-muted-foreground)]">
              Showing first {MAX_VISIBLE_OPTIONS} — keep typing to narrow.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
