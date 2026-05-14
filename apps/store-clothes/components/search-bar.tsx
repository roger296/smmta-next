'use client';

/**
 * Header search bar.
 *
 * Submits a natural-language query to `/shop/search?q=...`. The
 * server-rendered results page does all the actual work — this
 * component is just the form. Keeps the JS bundle tiny.
 *
 * Placeholder text rotates on each render to suggest example
 * queries — helps customers grok the "you can describe what you
 * want" interaction model.
 */
import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const PLACEHOLDERS = [
  'What are you shopping for today?',
  'Try: hi-vis polos for our delivery team',
  "Try: kids' rugby kit in red",
  'Try: navy fleece under £40',
  'Try: bib aprons for the cafe',
];

export function SearchBar() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initial = searchParams.get('q') ?? '';
  const [value, setValue] = React.useState(initial);
  const [placeholder, setPlaceholder] = React.useState(PLACEHOLDERS[0]!);

  // Rotate the placeholder once at mount so a user reloading the page
  // sees a different example. Avoids hydration-mismatch noise by
  // running only after mount.
  React.useEffect(() => {
    setPlaceholder(PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)]!);
  }, []);

  // Keep input in sync when the URL changes (e.g. navigated back to
  // a different query).
  React.useEffect(() => {
    setValue(initial);
  }, [initial]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    router.push(`/shop/search?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <form
      onSubmit={submit}
      role="search"
      className="flex w-full max-w-xl items-center border border-[var(--brand-border)] bg-[var(--brand-paper)] focus-within:border-[var(--brand-ink)]"
    >
      <label htmlFor="conversational-search" className="sr-only">
        Search
      </label>
      <input
        id="conversational-search"
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="flex-1 bg-transparent px-4 py-2 text-sm outline-none placeholder:text-[var(--brand-muted)]"
      />
      <button
        type="submit"
        className="border-l border-[var(--brand-border)] bg-[var(--brand-ink)] px-4 py-2 text-xs font-semibold uppercase tracking-wider text-[var(--brand-paper)] transition-colors hover:bg-[var(--brand-accent)]"
        aria-label="Search"
      >
        Search
      </button>
    </form>
  );
}
