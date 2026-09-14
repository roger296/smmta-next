/**
 * Company + contact details used across the legal pages (terms, returns,
 * privacy) and the site footer.
 *
 * UK law (Companies Act 2006 s.82 + the Consumer Contracts (Information,
 * Cancellation and Additional Charges) Regulations 2013) requires a trader
 * selling online to display its legal name, geographic address and contact
 * details. Editing them here updates every legal page at once.
 *
 * The company details are the ones Roger confirmed for the Filament Store
 * (apps/store/lib/legal.ts): the Clothes Shop is another CleverDeals store run
 * by the same company, and TBV Limited is the contracting party for every order.
 */

export const LEGAL = {
  /** Trading name shown to customers. */
  storeName: 'Clothes Shop',
  /** Parent brand — the Clothes Shop is a CleverDeals store. */
  parentName: 'CleverDeals',
  parentUrl: 'https://cleverdeals.net/',

  /** Registered company name (Companies House). */
  legalEntity: 'TBV Limited',
  /** Companies House registration number. */
  companyNumber: '13279893',
  /** Registered office, which is also the geographic contact address. */
  registeredAddress: 'Suite 48, Beechfield House, Winterton Way, Macclesfield, SK11 0LP',
  /**
   * Where returned goods are sent. Items are posted by our supplier partners,
   * so the returns policy asks customers for a returns reference first; the
   * reply confirms where to send that parcel.
   */
  returnsAddress: 'Close Cottage, Mow Lane, Off Congleton Road, ST7 3PL',
  /** VAT registration number. */
  vatNumber: 'GB 378 4829 39' as string | null,

  /** The single customer-facing contact address. */
  contactEmail: 'sales@cleverdeals.net',

  siteUrl: 'https://clothes.cleverdeals.net',

  /** Shown as "last updated" on every legal page. */
  lastUpdated: 'September 2026',

  /** Returns window in days (goodwill period — see the returns policy). */
  returnsWindowDays: 28,
  /** Statutory distance-selling cancellation window (do not change: this is law). */
  statutoryCancellationDays: 14,
} as const;
