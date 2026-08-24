/**
 * Company + contact details used across the legal pages (terms, returns,
 * privacy) and the site footer.
 *
 * UK law (Companies Act 2006 s.82 + the Consumer Contracts (Information,
 * Cancellation and Additional Charges) Regulations 2013) requires a trader
 * selling online to display its legal name, geographic address and contact
 * details. Editing them here updates every legal page at once.
 *
 * Corporate chain: TBV Limited → trades as CleverDeals → Filament Store is a
 * CleverDeals sub-brand. The contracting party for every order is TBV Limited.
 */

export const LEGAL = {
  /** Trading name shown to customers. */
  storeName: 'Filament Store',
  /** Parent brand — Filament Store trades as a sub-brand of CleverDeals. */
  parentName: 'CleverDeals',
  parentUrl: 'https://cleverdeals.net/',

  /** Registered company name (Companies House, verified 2026-07). */
  legalEntity: 'TBV Limited',
  /** Companies House registration number. */
  companyNumber: '13279893',
  /**
   * Registered office. Changed to Macclesfield in 2026; the Companies House
   * public record may still show the previous Congleton address until the
   * change propagates. Serves as both the registered office (Companies Act
   * 2006 s.82) and the geographic contact address the Consumer Contracts
   * Regulations 2013 require.
   */
  registeredAddress: 'Suite 48, Beechfield House, Winterton Way, Macclesfield, SK11 0LP',
  /**
   * Where returned goods are sent — the warehouse, not the registered office.
   * Published on the returns policy so customers can see it up front, but the
   * policy still asks them to request a returns reference first so an inbound
   * parcel can be matched to its order.
   */
  returnsAddress: 'Close Cottage, Mow Lane, Off Congleton Road, ST7 3PL',
  /** VAT registration number (checksum-valid under the mod-9755 rule). */
  vatNumber: 'GB 378 4829 39' as string | null,

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
