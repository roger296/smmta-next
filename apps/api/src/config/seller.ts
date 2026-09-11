/**
 * The business that issues invoices — tenant configuration.
 *
 * A UK VAT invoice must show the supplier's name, address and VAT registration
 * number. These mirror apps/store/lib/legal.ts, which the storefront's legal
 * pages and footer use; the two apps do not share code, so change both
 * together. A re-skinned deployment sets its own here.
 */
export const SELLER = {
  /** Brand shown at the top of the invoice. */
  brand: 'Filament Store',
  /** Trading name the brand sits under. */
  tradingAs: 'CleverDeals',
  /** Registered company: the legal supplier on every invoice. */
  legalName: 'TBV Limited',
  companyNumber: '13279893',
  registeredOffice: 'Suite 48, Beechfield House, Winterton Way, Macclesfield, SK11 0LP',
  addressLines: ['Suite 48, Beechfield House', 'Winterton Way', 'Macclesfield', 'SK11 0LP'],
  vatNumber: 'GB 378 4829 39',
  email: 'sales@cleverdeals.net',
  website: 'filament.cleverdeals.net',
} as const;
