'use client';

/**
 * Client-side checkout form. Validates locally, posts to
 * /api/checkout/start, redirects the customer to the Mollie checkout URL.
 *
 * 409 INSUFFICIENT_STOCK is rendered inline as a friendly "only N left in
 * this colour" message — never as a stack trace (Prompt 10 acceptance).
 */
import * as React from 'react';

interface ApiSuccess {
  checkoutId: string;
  checkoutUrl: string;
}

interface ApiError {
  error: string;
  productId?: string;
  available?: number;
  requested?: number;
  reason?: string;
}

const initial = {
  email: '',
  firstName: '',
  lastName: '',
  phone: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postCode: '',
  country: 'GB',
  separateBilling: false,
  billing: {
    line1: '',
    line2: '',
    city: '',
    region: '',
    postCode: '',
    country: 'GB',
  },
  termsAccepted: false,
};

export function CheckoutForm() {
  const [state, setState] = React.useState(initial);
  const [submitting, setSubmitting] = React.useState(false);
  const [errorBanner, setErrorBanner] = React.useState<string | null>(null);

  const set = <K extends keyof typeof state>(k: K, v: (typeof state)[K]) =>
    setState((s) => ({ ...s, [k]: v }));

  const setBilling = <K extends keyof typeof initial.billing>(k: K, v: string) =>
    setState((s) => ({ ...s, billing: { ...s.billing, [k]: v } }));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Disabling the button is not enough: pressing Enter in any text field
    // still submits the form. Without this guard a second press during the
    // redirect would reserve the stock twice and open a second Mollie payment.
    if (submitting) return;
    setErrorBanner(null);
    if (!state.termsAccepted) {
      setErrorBanner('You must accept the terms and conditions to checkout.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/checkout/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: {
            email: state.email,
            firstName: state.firstName,
            lastName: state.lastName,
            phone: state.phone || undefined,
          },
          deliveryAddress: {
            line1: state.line1,
            line2: state.line2 || undefined,
            city: state.city,
            region: state.region || undefined,
            postCode: state.postCode,
            country: state.country,
          },
          invoiceAddress: state.separateBilling
            ? {
                line1: state.billing.line1,
                line2: state.billing.line2 || undefined,
                city: state.billing.city,
                region: state.billing.region || undefined,
                postCode: state.billing.postCode,
                country: state.billing.country,
              }
            : undefined,
          termsAccepted: true,
        }),
      });
      if (res.ok) {
        const ok = (await res.json()) as ApiSuccess;
        window.location.href = ok.checkoutUrl;
        return;
      }
      const body = (await res.json().catch(() => ({}))) as ApiError;
      if (body.error === 'INSUFFICIENT_STOCK') {
        setErrorBanner(
          `Only ${body.available} left in stock for one of the items in your basket. ` +
            `Please reduce the quantity in your cart and try again.`,
        );
      } else if (body.error === 'EMPTY_CART') {
        setErrorBanner('Your basket is empty. Add an item before checking out.');
      } else if (body.error === 'PAYMENT_CREATE_FAILED') {
        setErrorBanner(
          `We couldn't reach the payment provider just now (${body.reason ?? 'unknown error'}). ` +
            `Please try again in a moment.`,
        );
      } else {
        setErrorBanner(body.error || `Something went wrong (${res.status}).`);
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Network error');
      setSubmitting(false);
      return;
    }
    // Only reached on a handled error response — the success path has already
    // returned and is navigating away, and must stay locked until it does.
    setSubmitting(false);
  };

  return (
    <>
      {submitting && <ProcessingOverlay />}
      <form
        onSubmit={onSubmit}
        className="space-y-6"
        aria-labelledby="checkout-heading"
        aria-busy={submitting}
      >
      {errorBanner && (
        <div
          role="alert"
          className="rounded-[var(--radius)] border border-[var(--brand-accent)] bg-[var(--brand-paper)] p-3 text-sm"
        >
          {errorBanner}
        </div>
      )}

      <fieldset className="space-y-3">
        <legend className="text-base font-medium">Contact</legend>
        <Field
          id="cf-email" name="email"
          label="Email"
          required
          value={state.email}
          onChange={(v) => set('email', v)}
          type="email"
          autoComplete="email"
          inputMode="email"
        />
        <div className="grid gap-3 md:grid-cols-2">
          <Field id="cf-first" name="firstName" label="First name" required value={state.firstName} onChange={(v) => set('firstName', v)} autoComplete="given-name" />
          <Field id="cf-last" name="lastName" label="Last name" required value={state.lastName} onChange={(v) => set('lastName', v)} autoComplete="family-name" />
        </div>
        <Field id="cf-phone" name="phone" label="Phone (optional)" value={state.phone} onChange={(v) => set('phone', v)} type="tel" autoComplete="tel" inputMode="tel" />
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-base font-medium">Delivery address</legend>
        <Field id="cf-line1" name="line1" label="Address line 1" required value={state.line1} onChange={(v) => set('line1', v)} autoComplete="address-line1" />
        <Field id="cf-line2" name="line2" label="Address line 2 (optional)" value={state.line2} onChange={(v) => set('line2', v)} autoComplete="address-line2" />
        <div className="grid gap-3 md:grid-cols-2">
          <Field id="cf-city" name="city" label="City" required value={state.city} onChange={(v) => set('city', v)} autoComplete="address-level2" />
          <Field id="cf-region" name="region" label="County / region" value={state.region} onChange={(v) => set('region', v)} autoComplete="address-level1" />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {/*
            No inputMode="numeric" here, despite it being a common
            recommendation: UK postcodes are alphanumeric (SK11 0LP), so
            a numeric keypad would make the field impossible to complete
            on a handset. That advice is sound for US ZIP codes only.
          */}
          <Field id="cf-postcode" name="postCode" label="Post code" required value={state.postCode} onChange={(v) => set('postCode', v)} autoComplete="postal-code" />
          <CountryField id="cf-country" name="country" value={state.country} onChange={(v) => set('country', v)} />
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-base font-medium">Billing address</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={state.separateBilling}
            onChange={(e) => set('separateBilling', e.target.checked)}
          />
          Use a different billing address
        </label>
        {state.separateBilling && (
          <div className="space-y-3">
            <Field id="bf-line1" name="billing-line1" label="Address line 1" required value={state.billing.line1} onChange={(v) => setBilling('line1', v)} autoComplete="billing address-line1" />
            <Field id="bf-line2" name="billing-line2" label="Address line 2 (optional)" value={state.billing.line2} onChange={(v) => setBilling('line2', v)} autoComplete="billing address-line2" />
            <div className="grid gap-3 md:grid-cols-2">
              <Field id="bf-city" name="billing-city" label="City" required value={state.billing.city} onChange={(v) => setBilling('city', v)} autoComplete="billing address-level2" />
              <Field id="bf-region" name="billing-region" label="County / region" value={state.billing.region} onChange={(v) => setBilling('region', v)} autoComplete="billing address-level1" />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Field id="bf-postcode" name="billing-postCode" label="Post code" required value={state.billing.postCode} onChange={(v) => setBilling('postCode', v)} autoComplete="billing postal-code" />
              <CountryField id="bf-country" name="billing-country" value={state.billing.country} onChange={(v) => setBilling('country', v)} />
            </div>
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-base font-medium">Shipping</legend>
        <p className="rounded-[var(--radius)] border border-[var(--brand-border)] p-3 text-sm">
          Standard tracked delivery (1–2 working days from the workshop) — fixed rate shown in the
          order summary.
        </p>
      </fieldset>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="termsAccepted"
          checked={state.termsAccepted}
          onChange={(e) => set('termsAccepted', e.target.checked)}
          required
        />
        <span>
          I&rsquo;ve read and accept the&nbsp;
          <a href="/legal/terms" className="underline" target="_blank" rel="noreferrer">
            terms and conditions
          </a>
          &nbsp;and&nbsp;
          <a href="/legal/returns" className="underline" target="_blank" rel="noreferrer">
            returns policy
          </a>
          .
        </span>
      </label>

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-[var(--radius)] bg-[var(--brand-ink)] px-6 py-3 text-base font-medium text-[var(--brand-paper)] transition-colors hover:bg-[var(--brand-accent)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? 'Redirecting to Mollie…' : 'Pay with Mollie'}
      </button>
      <p className="text-xs text-[var(--brand-muted)]">
        You&rsquo;ll be redirected to Mollie&rsquo;s secure hosted checkout. Card details never
        touch our servers (PCI SAQ A).
      </p>
      </form>
    </>
  );
}

/**
 * Covers the checkout while the payment is being opened.
 *
 * The form used to stay on screen and interactive for the second or two it
 * takes to create the Mollie payment and redirect. Only the button was
 * disabled, so the page still invited input — and a stray Enter would have
 * started a second checkout entirely.
 *
 * Rendered as a sibling of the form rather than inside it, so it sits above
 * every field rather than in the document flow.
 */
function ProcessingOverlay() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--brand-paper)]/95 p-6"
    >
      <div className="max-w-md text-center">
        <p
          className="text-2xl font-bold tracking-tight"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Thanks for your order
        </p>
        <p className="mt-3 text-base text-[var(--brand-muted)]">
          We&rsquo;re processing the transaction with your card company. Please wait &mdash; do
          not close this page or press back.
        </p>
        <div
          aria-hidden="true"
          className="mx-auto mt-6 h-1 w-40 overflow-hidden bg-[var(--brand-border)]"
        >
          <div className="h-1 w-1/3 animate-pulse bg-[var(--brand-accent)]" />
        </div>
      </div>
    </div>
  );
}

interface FieldProps {
  id: string;
  /** Form-element `name` — also what e2e/Playwright targets via `input[name=…]`. */
  name?: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  type?: string;
  /**
   * WHATWG autofill token. Not optional in practice — every field on a
   * checkout has a correct one, and without it browser and iOS/Android
   * address autofill silently does nothing, so a mobile customer types
   * a full delivery address by hand at exactly the moment they are most
   * likely to abandon. Left typed as optional only because the
   * marketing-consent checkbox below reuses nothing from here.
   */
  autoComplete?: string;
  /** Surfaces the right on-screen keyboard: 'numeric' for postcodes. */
  inputMode?: 'text' | 'numeric' | 'tel' | 'email';
}
function Field({
  id,
  name,
  label,
  value,
  onChange,
  required,
  type = 'text',
  autoComplete,
  inputMode,
}: FieldProps) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm">
        {label}
        {required && <span className="ml-0.5 text-[var(--brand-accent)]">*</span>}
      </label>
      <input
        id={id}
        name={name ?? id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        autoComplete={autoComplete}
        inputMode={inputMode}
        // min-h-11 = 44px: the iOS/WCAG touch-target floor. The visual
        // density is unchanged on desktop; this only stops the control
        // being smaller than a fingertip on a handset.
        className="min-h-11 w-full rounded-[var(--radius)] border border-[var(--brand-border)] bg-transparent px-3 py-2 text-sm focus-visible:border-[var(--brand-ink)] focus-visible:outline-none"
      />
    </div>
  );
}

/**
 * Countries we ship to.
 *
 * Country was a free-text box, which is the field that decides shipping
 * cost, VAT treatment and whether duties apply on arrival — so "UK",
 * "U.K.", "England", "Great Britain" and "united kingdon" all arrived
 * and all broke downstream rate logic. The value stored is the ISO
 * 3166-1 alpha-2 code, not the display string.
 *
 * The list is the UK plus the EU states the FAQ says we ship to; extend
 * it when carriage rates for a new destination actually exist rather
 * than offering a country the checkout can't price.
 */
const SHIPPING_COUNTRIES: Array<{ code: string; name: string }> = [
  { code: 'GB', name: 'United Kingdom' },
  { code: 'IE', name: 'Ireland' },
  { code: 'AT', name: 'Austria' },
  { code: 'BE', name: 'Belgium' },
  { code: 'BG', name: 'Bulgaria' },
  { code: 'HR', name: 'Croatia' },
  { code: 'CY', name: 'Cyprus' },
  { code: 'CZ', name: 'Czechia' },
  { code: 'DK', name: 'Denmark' },
  { code: 'EE', name: 'Estonia' },
  { code: 'FI', name: 'Finland' },
  { code: 'FR', name: 'France' },
  { code: 'DE', name: 'Germany' },
  { code: 'GR', name: 'Greece' },
  { code: 'HU', name: 'Hungary' },
  { code: 'IT', name: 'Italy' },
  { code: 'LV', name: 'Latvia' },
  { code: 'LT', name: 'Lithuania' },
  { code: 'LU', name: 'Luxembourg' },
  { code: 'MT', name: 'Malta' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'PL', name: 'Poland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'RO', name: 'Romania' },
  { code: 'SK', name: 'Slovakia' },
  { code: 'SI', name: 'Slovenia' },
  { code: 'ES', name: 'Spain' },
  { code: 'SE', name: 'Sweden' },
];

function CountryField({
  id,
  name,
  value,
  onChange,
}: {
  id: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm">
        Country
        <span className="ml-0.5 text-[var(--brand-accent)]">*</span>
      </label>
      <select
        id={id}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        autoComplete="country"
        className="min-h-11 w-full rounded-[var(--radius)] border border-[var(--brand-border)] bg-transparent px-3 py-2 text-sm focus-visible:border-[var(--brand-ink)] focus-visible:outline-none"
      >
        {SHIPPING_COUNTRIES.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}
