/**
 * List-Unsubscribe headers for marketing mail (RFC 2369 + RFC 8058). Gmail
 * and Yahoo require both for bulk senders and call the https URL with
 * `List-Unsubscribe=One-Click` as the POST body. Not used on order-required
 * mail.
 */
import { getEnv } from '../../../config/env.js';
import { storefrontBaseUrl } from './config.js';

export function unsubscribeUrl(token: string): string {
  return `${storefrontBaseUrl()}/email/u/${encodeURIComponent(token)}`;
}

export function preferencesUrl(token: string): string {
  return `${storefrontBaseUrl()}/email/preferences/${encodeURIComponent(token)}`;
}

export function marketingHeaders(contact: { unsubscribeToken: string }): Record<string, string> {
  const token = contact.unsubscribeToken;
  const mailto = `mailto:${getEnv().EMAIL_UNSUBSCRIBE_MAILTO}?subject=${encodeURIComponent(token)}`;
  return {
    'List-Unsubscribe': `<${unsubscribeUrl(token)}>, <${mailto}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
