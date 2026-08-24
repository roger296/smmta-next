/**
 * Company + contact details used across the legal pages (terms, returns,
 * privacy) and the site footer.
 *
 * ⚠️ ACTION REQUIRED BEFORE LAUNCH — the values marked `TODO` are placeholders.
 * UK law (Companies Act 2006 s.82 + the Consumer Contracts (Information,
 * Cancellation and Additional Charges) Regulations 2013) requires a trader
 * selling online to display its legal name, geographic address and contact
 * details. Fill these in and the legal pages update everywhere at once.
 */

export const LEGAL = {
  /** Trading name shown to customers. */
  storeName: 'Filament Store',
  /** Parent brand — Filament Store trades as a sub-brand of CleverDeals. */
  parentName: 'CleverDeals',
  parentUrl: 'https://cleverdeals.net/',

  /** TODO: registered company name, e.g. "Example Trading Ltd". */
  legalEntity: '[COMPANY LEGAL NAME]',
  /** TODO: Companies House registration number. */
  companyNumber: '[COMPANY NUMBER]',
  /** TODO: registered office address (single line or comma-separated). */
  registeredAddress: '[REGISTERED OFFICE ADDRESS]',
  /**
   * TODO: VAT registration number, or set to null if not VAT-registered.
   * If null, the pages omit the VAT line entirely rather than showing a blank.
   */
  vatNumber: '[VAT NUMBER]' as string | null,

  /** Customer-facing addresses. */
  ordersEmail: 'orders@filament.cleverdeals.net',
  returnsEmail: 'returns@filament.cleverdeals.net',
  privacyEmail: 'privacy@cleverdeals.net',

  siteUrl: 'https://filament.cleverdeals.net',

  /** Shown as "last updated" on every legal page. */
  lastUpdated: 'July 2026',

  /** Returns window in days (goodwill period — see the returns policy). */
  returnsWindowDays: 28,
  /** Statutory distance-selling cancellation window (do not change: this is law). */
  statutoryCancellationDays: 14,
} as const;
