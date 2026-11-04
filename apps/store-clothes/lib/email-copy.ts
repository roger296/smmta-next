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
  'Email me about new arrivals and offers. You can unsubscribe at any time.';

/** Strapline for the footer newsletter signup. */
export const NEWSLETTER_SIGNUP_COPY =
  'New arrivals and the occasional offer. Unsubscribe at any time.';

/** SMMTA channel slug this storefront reports baskets under. */
export const EMAIL_CHANNEL = 'clothes-shop';

/** Interests a subscriber can pick. None offered on this shop yet — the
 *  signup is just the email address. */
export const NEWSLETTER_INTERESTS: ReadonlyArray<{ key: string; name: string }> = [];
