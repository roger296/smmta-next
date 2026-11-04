'use client';

/**
 * Footer newsletter signup. Active opt-in only: nothing is ticked or
 * submitted for the shopper — they type their address and press the button.
 *
 * Posts to /api/email/subscribe, which forwards to SMMTA. The thank-you
 * message is the same whether or not the address was already on the list.
 *
 * Copy and the interest list come from `lib/email-copy.ts`, so a re-skinned
 * storefront changes them there rather than here.
 */
import * as React from 'react';
import { NEWSLETTER_INTERESTS, NEWSLETTER_SIGNUP_COPY } from '@/lib/email-copy';

type Status = 'idle' | 'sending' | 'done' | 'error';

export function NewsletterSignup() {
  const [email, setEmail] = React.useState('');
  const [interests, setInterests] = React.useState<string[]>([]);
  const [status, setStatus] = React.useState<Status>('idle');

  const toggle = (key: string, on: boolean) =>
    setInterests((cur) => (on ? [...cur, key] : cur.filter((k) => k !== key)));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || status === 'sending') return;
    setStatus('sending');
    try {
      const res = await fetch('/api/email/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, interests }),
      });
      setStatus(res.ok ? 'done' : 'error');
    } catch {
      setStatus('error');
    }
  }

  return (
    <section aria-labelledby="newsletter-heading" className="min-w-0">
      <h2
        id="newsletter-heading"
        className="mb-2 text-xs font-semibold uppercase tracking-[0.15em] text-[var(--brand-ink)]"
      >
        Newsletter
      </h2>
      <p className="mb-3 max-w-md leading-relaxed">{NEWSLETTER_SIGNUP_COPY}</p>

      {status === 'done' ? (
        <p role="status" className="text-[var(--brand-ink)]">
          Thanks — you&rsquo;re signed up.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="max-w-md space-y-3">
          <div className="space-y-1">
            <label htmlFor="newsletter-email" className="block text-[var(--brand-ink)]">
              Email address
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="newsletter-email"
                name="email"
                type="email"
                required
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="min-h-11 w-full min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--brand-border)] bg-[var(--brand-paper)] px-3 py-2 text-sm text-[var(--brand-ink)] focus-visible:border-[var(--brand-ink)] focus-visible:outline-none"
              />
              <button
                type="submit"
                disabled={status === 'sending'}
                className="min-h-11 shrink-0 rounded-[var(--radius)] bg-[var(--brand-ink)] px-5 py-2 text-sm font-medium text-[var(--brand-paper)] transition-colors hover:bg-[var(--brand-accent)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {status === 'sending' ? 'Signing you up…' : 'Sign me up'}
              </button>
            </div>
          </div>

          {NEWSLETTER_INTERESTS.length > 0 && (
            <fieldset>
              <legend className="mb-2 text-[var(--brand-ink)]">
                Interested in (optional)
              </legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {NEWSLETTER_INTERESTS.map((i) => (
                  <label key={i.key} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      name="interests"
                      value={i.key}
                      checked={interests.includes(i.key)}
                      onChange={(e) => toggle(i.key, e.target.checked)}
                    />
                    {i.name}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {status === 'error' && (
            <p role="alert" className="text-[var(--brand-ink)]">
              Sorry, we couldn&rsquo;t sign you up just now. Please try again.
            </p>
          )}
        </form>
      )}
    </section>
  );
}
