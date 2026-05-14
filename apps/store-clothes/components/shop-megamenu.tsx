'use client';

/**
 * Header "Shop" megamenu.
 *
 * Hover (desktop) or focus (keyboard) reveals a panel of the seven
 * top-tier categories + their subcategories. Click "Shop" itself to
 * go to /shop (the flat catalogue page) as a fallback.
 *
 * Categories are passed in as a prop — the server layout fetches them
 * once per request and we render. No client-side fetch.
 *
 * Accessibility:
 *   - The trigger is a real `<a href="/shop">` so it works without JS
 *     and with screen readers.
 *   - The panel uses `aria-expanded`/`aria-controls` for keyboard users.
 *   - Hover + focus both open it.
 *   - Escape closes it; clicking outside closes it.
 */
import * as React from 'react';
import Link from 'next/link';

export interface NavCategoryTop {
  slug: string;
  name: string;
  description: string | null;
  children: Array<{ slug: string; name: string }>;
}

export function ShopMegamenu({ categories }: { categories: NavCategoryTop[] }) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  // Close on outside click + Escape.
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Empty / failed fetch — degrade to a plain Shop link.
  if (categories.length === 0) {
    return (
      <Link href="/shop" className="transition-colors hover:text-[var(--brand-accent)]">
        Shop
      </Link>
    );
  }

  return (
    <div
      ref={rootRef}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <Link
        href="/shop"
        aria-expanded={open}
        aria-controls="shop-megamenu-panel"
        onFocus={() => setOpen(true)}
        className="inline-flex items-center gap-1 transition-colors hover:text-[var(--brand-accent)]"
      >
        Shop
        <span aria-hidden="true" className="text-xs text-[var(--brand-muted)]">
          ▾
        </span>
      </Link>
      {open && (
        <div
          id="shop-megamenu-panel"
          role="region"
          aria-label="Shop categories"
          className="absolute left-0 top-full z-30 mt-2 w-screen max-w-3xl border border-[var(--brand-border)] bg-[var(--brand-paper)] p-6 shadow-lg"
          // Keep the panel open when the cursor moves into it.
          onMouseEnter={() => setOpen(true)}
        >
          <div className="grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
            {categories.map((top) => (
              <div key={top.slug}>
                <Link
                  href={`/shop/c/${top.slug}`}
                  className="block text-xs font-semibold uppercase tracking-[0.15em] text-[var(--brand-accent)] transition-colors hover:text-[var(--brand-ink)]"
                  onClick={() => setOpen(false)}
                >
                  {top.name}
                </Link>
                <ul className="mt-3 space-y-1.5 text-sm">
                  {top.children.map((sub) => (
                    <li key={sub.slug}>
                      <Link
                        href={`/shop/c/${top.slug}/${sub.slug}`}
                        className="block text-[var(--brand-ink)] transition-colors hover:text-[var(--brand-accent)]"
                        onClick={() => setOpen(false)}
                      >
                        {sub.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="mt-6 border-t border-[var(--brand-border)] pt-4 text-xs">
            <Link
              href="/shop"
              className="font-semibold uppercase tracking-wider text-[var(--brand-muted)] hover:text-[var(--brand-ink)]"
              onClick={() => setOpen(false)}
            >
              Browse all ranges →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
