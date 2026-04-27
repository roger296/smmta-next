/**
 * Storefront home — Prompt 7 scaffold only.
 *
 * Prompt 8 replaces this with the real catalogue-driven home page. For now
 * the page exists primarily to verify the brand-token wiring and to give
 * Lighthouse something content-shaped to score.
 */
export default function HomePage() {
  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h1
          className="text-4xl font-semibold tracking-tight"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Hand-finished LED filament lighting.
        </h1>
        <p className="text-lg text-[var(--brand-muted)]">
          A new home for the Filament Store. The shopfront opens in stages — this is the storefront
          scaffold that the catalogue, cart, and checkout build on.
        </p>
      </header>

      <div
        data-testid="brand-token-probe"
        className="grid gap-3 sm:grid-cols-2 md:grid-cols-3"
      >
        <BrandTokenSwatch label="Paper" varName="--brand-paper" />
        <BrandTokenSwatch label="Ink" varName="--brand-ink" />
        <BrandTokenSwatch label="Accent" varName="--brand-accent" />
        <BrandTokenSwatch label="Muted" varName="--brand-muted" />
        <BrandTokenSwatch label="Border" varName="--brand-border" />
      </div>

      <p>
        <a
          href="/healthz"
          className="inline-block rounded-[var(--radius)] border border-[var(--brand-border)] px-4 py-2 text-sm hover:bg-[var(--brand-accent)] hover:text-[var(--brand-paper)]"
        >
          Health probe →
        </a>
      </p>
    </section>
  );
}

function BrandTokenSwatch({ label, varName }: { label: string; varName: string }) {
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius)] border border-[var(--brand-border)] p-3">
      <span
        aria-hidden="true"
        className="h-10 w-10 flex-shrink-0 rounded-[var(--radius)]"
        style={{ background: `var(${varName})`, border: '1px solid var(--brand-border)' }}
      />
      <span className="text-sm">
        <span className="block font-medium">{label}</span>
        <code className="text-xs text-[var(--brand-muted)]">{varName}</code>
      </span>
    </div>
  );
}
