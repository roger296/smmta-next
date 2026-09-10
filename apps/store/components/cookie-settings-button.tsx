'use client';

/** Reopens the cookie consent banner, so a visitor can change their choice at any time. */
import { OPEN_COOKIE_SETTINGS_EVENT } from '@/lib/analytics';

export function CookieSettingsButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => window.dispatchEvent(new Event(OPEN_COOKIE_SETTINGS_EVENT))}
    >
      Cookie settings
    </button>
  );
}
