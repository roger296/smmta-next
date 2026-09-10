'use client';

/**
 * Cookie consent banner, and the Google Analytics loader it gates.
 *
 * Nothing from Google is requested until the visitor accepts. Reject is offered
 * with exactly the same prominence as Accept, as the ICO expects. A refusal
 * after an earlier acceptance switches analytics storage off and deletes the
 * cookies GA had already set. The footer's "Cookie settings" link reopens the
 * banner at any time.
 *
 * Deliberately a labelled region, not role="status": the checkout tests assert
 * on status messages, and a banner is not one.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  CONSENT_STORAGE_KEY,
  OPEN_COOKIE_SETTINGS_EVENT,
  analyticsCookieNames,
  cookieDomainsFor,
  parseConsent,
  serialiseConsent,
  type AnalyticsConsent as Choice,
} from '@/lib/analytics';

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

function readChoice(): Choice | null {
  try {
    return parseConsent(window.localStorage.getItem(CONSENT_STORAGE_KEY));
  } catch {
    return null;
  }
}

function saveChoice(choice: Choice): void {
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, serialiseConsent(choice));
  } catch {
    // Storage blocked (some private modes): the visitor is simply asked again next time.
  }
}

function startAnalytics(measurementId: string): void {
  if (window.gtag) {
    window.gtag('consent', 'update', { analytics_storage: 'granted' });
    return;
  }
  window.dataLayer = window.dataLayer ?? [];
  // gtag.js reads the `arguments` object itself from the data layer, not an array.
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  // Analytics only. Advertising features stay off whatever the visitor chooses.
  window.gtag('consent', 'default', {
    analytics_storage: 'granted',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  });
  window.gtag('js', new Date());
  window.gtag('config', measurementId);

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  document.head.appendChild(script);
}

function stopAnalytics(): void {
  window.gtag?.('consent', 'update', { analytics_storage: 'denied' });
  const domains = cookieDomainsFor(window.location.hostname);
  for (const name of analyticsCookieNames(document.cookie)) {
    document.cookie = `${name}=; Max-Age=0; path=/`;
    for (const domain of domains) document.cookie = `${name}=; Max-Age=0; path=/; domain=${domain}`;
  }
}

const buttonClass =
  'min-h-11 flex-1 cursor-pointer border border-[var(--brand-ink)] bg-[var(--brand-bone)] px-4 font-semibold text-[var(--brand-ink)] transition-colors hover:bg-[var(--brand-accent-ice)] focus-visible:outline-2 focus-visible:outline-[var(--brand-accent)]';

export function AnalyticsConsent({ measurementId }: { measurementId: string | null }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!measurementId) return;
    const choice = readChoice();
    if (choice === 'granted') startAnalytics(measurementId);
    if (choice === null) setOpen(true);

    const reopen = () => setOpen(true);
    window.addEventListener(OPEN_COOKIE_SETTINGS_EVENT, reopen);
    return () => window.removeEventListener(OPEN_COOKIE_SETTINGS_EVENT, reopen);
  }, [measurementId]);

  const choose = useCallback(
    (choice: Choice) => {
      saveChoice(choice);
      setOpen(false);
      if (!measurementId) return;
      if (choice === 'granted') startAnalytics(measurementId);
      else stopAnalytics();
    },
    [measurementId],
  );

  if (!measurementId || !open) return null;

  return (
    // Bottom-left, above the chat button on handsets (which sits bottom-right)
    // and below it in the stacking order.
    <section
      aria-label="Cookie consent"
      className="fixed bottom-16 left-2 z-40 w-[min(26rem,calc(100vw-1rem))] border border-[var(--brand-border)] bg-[var(--brand-bone)] p-4 text-sm text-[var(--brand-ink)] sm:bottom-5 sm:left-5"
    >
      <p className="leading-relaxed">
        We&rsquo;d like to use Google Analytics cookies to see how the site is used, so we can
        improve it. They&rsquo;re only set if you accept.{' '}
        <a href="/legal/privacy#cookies" className="underline underline-offset-2 hover:text-[var(--brand-accent)]">
          Privacy policy
        </a>
      </p>
      <div className="mt-3 flex gap-2">
        <button type="button" className={buttonClass} onClick={() => choose('granted')}>
          Accept
        </button>
        <button type="button" className={buttonClass} onClick={() => choose('denied')}>
          Reject
        </button>
      </div>
    </section>
  );
}
