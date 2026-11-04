/**
 * The trader's details for the email footer. UK law (Companies Act 2006 s.82,
 * Consumer Contracts Regulations 2013) wants the legal name, registered
 * address and company number on business email as on the website. These are
 * the storefront's own values (apps/store/lib/legal.ts); a test keeps the two
 * in step.
 */
export const COMPANY = {
  tradingName: 'CleverDeals',
  legalEntity: 'TBV Limited',
  companyNumber: '13279893',
  registeredAddress: 'Suite 48, Beechfield House, Winterton Way, Macclesfield, SK11 0LP',
  vatNumber: 'GB 378 4829 39',
  contactEmail: 'sales@cleverdeals.net',
} as const;
