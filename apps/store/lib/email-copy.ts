/**
 * The exact words shown beside the email-marketing controls.
 *
 * Kept in one place because the same string is both rendered to the shopper
 * and sent to SMMTA as the consent `wording` — the record of what someone
 * agreed to has to match what they actually read. Change the copy here and
 * both follow.
 *
 * Not server-only: the checkout form and the newsletter signup (client
 * components) import it too.
 */

/** Label for the checkout tick box. Never pre-ticked. */
export const CHECKOUT_MARKETING_LABEL =
  'Email me about new filament and offers. You can unsubscribe at any time.';

/** Strapline for the footer newsletter signup. */
export const NEWSLETTER_SIGNUP_COPY =
  'New filament, back-in-stock news and the occasional offer. Unsubscribe at any time.';

/** SMMTA channel slug this storefront reports baskets under. */
export const EMAIL_CHANNEL = 'filament-store';

/** Interests a subscriber can pick. Keys match SMMTA's interest keys. */
export const NEWSLETTER_INTERESTS: ReadonlyArray<{ key: string; name: string }> = [
  { key: 'material:pla', name: 'PLA' },
  { key: 'material:petg', name: 'PETG' },
  { key: 'material:abs', name: 'ABS' },
  { key: 'material:asa', name: 'ASA' },
  { key: 'material:tpu', name: 'TPU' },
  { key: 'material:nylon', name: 'Nylon' },
  { key: 'material:carbon', name: 'Carbon fibre' },
  { key: 'material:silk', name: 'Silk' },
  { key: 'material:wood', name: 'Wood' },
];
