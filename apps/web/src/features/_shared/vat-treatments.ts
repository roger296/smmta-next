export const VAT_TREATMENTS = [
  { value: 'STANDARD_VAT_20', label: 'Standard VAT 20%' },
  { value: 'REDUCED_VAT_5', label: 'Reduced VAT 5%' },
  { value: 'ZERO_RATED', label: 'Zero Rated' },
  { value: 'EXEMPT', label: 'Exempt' },
  { value: 'OUTSIDE_SCOPE', label: 'Outside Scope' },
  { value: 'REVERSE_CHARGE', label: 'Reverse Charge' },
  { value: 'POSTPONED_VAT', label: 'Postponed VAT' },
] as const;

export const CURRENCIES = [
  { value: 'GBP', label: 'GBP (£)' },
  { value: 'USD', label: 'USD ($)' },
  { value: 'EUR', label: 'EUR (€)' },
] as const;
