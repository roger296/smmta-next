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
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-6" aria-labelledby="checkout-heading">
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
        />
        <div className="grid gap-3 md:grid-cols-2">
          <Field id="cf-first" name="firstName" label="First name" required value={state.firstName} onChange={(v) => set('firstName', v)} />
          <Field id="cf-last" name="lastName" label="Last name" required value={state.lastName} onChange={(v) => set('lastName', v)} />
        </div>
        <Field id="cf-phone" name="phone" label="Phone (optional)" value={state.phone} onChange={(v) => set('phone', v)} type="tel" />
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-base font-medium">Delivery address</legend>
        <Field id="cf-line1" name="line1" label="Address line 1" required value={state.line1} onChange={(v) => set('line1', v)} />
        <Field id="cf-line2" name="line2" label="Address line 2 (optional)" value={state.line2} onChange={(v) => set('line2', v)} />
        <div className="grid gap-3 md:grid-cols-2">
          <Field id="cf-city" name="city" label="City" required value={state.city} onChange={(v) => set('city', v)} />
          <Field id="cf-region" name="region" label="County / region" value={state.region} onChange={(v) => set('region', v)} />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Field id="cf-postcode" name="postCode" label="Post code" required value={state.postCode} onChange={(v) => set('postCode', v)} />
          <Field id="cf-country" name="country" label="Country" required value={state.country} onChange={(v) => set('country', v)} />
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
            <Field id="bf-line1" name="billing-line1" label="Address line 1" required value={state.billing.line1} onChange={(v) => setBilling('line1', v)} />
            <Field id="bf-line2" name="billing-line2" label="Address line 2 (optional)" value={state.billing.line2} onChange={(v) => setBilling('line2', v)} />
            <div className="grid gap-3 md:grid-cols-2">
              <Field id="bf-city" name="billing-city" label="City" required value={state.billing.city} onChange={(v) => setBilling('city', v)} />
              <Field id="bf-region" name="billing-region" label="County / region" value={state.billing.region} onChange={(v) => setBilling('region', v)} />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Field id="bf-postcode" name="billing-postCode" label="Post code" required value={state.billing.postCode} onChange={(v) => setBilling('postCode', v)} />
              <Field id="bf-country" name="billing-country" label="Country" required value={state.billing.country} onChange={(v) => setBilling('country', v)} />
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
}
function Field({ id, name, label, value, onChange, required, type = 'text' }: FieldProps) {
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
        className="w-full rounded-[var(--radius)] border border-[var(--brand-border)] bg-transparent px-3 py-2 text-sm focus-visible:border-[var(--brand-ink)] focus-visible:outline-none"
      />
    </div>
  );
}
