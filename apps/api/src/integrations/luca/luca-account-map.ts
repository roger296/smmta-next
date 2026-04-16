/**
 * Maps old SMMTA nominal ledger codes to Luca GL account codes.
 *
 * Source: Libraries/DSB.Data/Models/Ledgers.cs (LedgerCode class, lines 160-185)
 *
 * Luca accounts 1100, 2000, 2100, 4000, 5000 are standard.
 * Accounts 1150, 2310, 2320, 2330, 5010, 5020, 5030 must be created
 * in Luca before go-live via gl_create_account.
 */

// === Luca Standard Account Codes ===

export const LUCA_ACCOUNTS = {
  // Assets
  TRADE_DEBTORS: '1100',           // Accounts Receivable (old: CURA-6101)
  STOCK: '1150',                    // Inventory (old: CURA-6001)
  VAT_INPUT: '1200',               // VAT Recoverable (old: OTHR-4301)
  PREPAYMENTS: '1250',             // Prepayments (old: CURA-6201)

  // Liabilities
  TRADE_CREDITORS: '2000',         // Accounts Payable (old: CURL-7001)
  VAT_OUTPUT: '2100',              // VAT Payable (old: CURL-7301)
  GRNI_ACCRUAL: '2310',            // GRNI Accrual (old: CURL-7101)
  DELIVERY_GRNI_ACCRUAL: '2320',   // Delivery GRNI (old: CURL-7103)
  SERVICE_GRNI_ACCRUAL: '2330',    // Service GRNI (old: CURL-7109)
  GENERAL_ACCRUALS: '2340',        // General Accruals (old: CURL-7108)

  // Equity
  RETAINED_EARNINGS: '3100',       // P&L Reserve (old: SCAR-9401)

  // Revenue
  SALES_REVENUE: '4000',           // Revenue (old: SALE-0001)

  // Expenses
  COGS: '5000',                    // Cost of Goods Sold (old: COST-0101)
  STOCK_WRITE_OFFS: '5010',        // Stock Write-Offs (old: COST-0601)
  STOCK_WRITE_BACK: '5020',        // Stock Write-Back (old: COST-0602)
  DELIVERY_COSTS_IN: '5030',       // Supplier Delivery Cost (old: COST-0401)
  FX_GAINS_LOSSES: '7200',         // Currency Variation (old: ADMN-3013)
} as const;

// === Old-to-New Code Lookup ===

const OLD_TO_LUCA: Record<string, string> = {
  'CURA-6101': LUCA_ACCOUNTS.TRADE_DEBTORS,
  'CURA-6001': LUCA_ACCOUNTS.STOCK,
  'OTHR-4301': LUCA_ACCOUNTS.VAT_INPUT,
  'CURA-6201': LUCA_ACCOUNTS.PREPAYMENTS,
  'CURL-7001': LUCA_ACCOUNTS.TRADE_CREDITORS,
  'CURL-7301': LUCA_ACCOUNTS.VAT_OUTPUT,
  'CURL-7101': LUCA_ACCOUNTS.GRNI_ACCRUAL,
  'CURL-7103': LUCA_ACCOUNTS.DELIVERY_GRNI_ACCRUAL,
  'CURL-7109': LUCA_ACCOUNTS.SERVICE_GRNI_ACCRUAL,
  'CURL-7108': LUCA_ACCOUNTS.GENERAL_ACCRUALS,
  'SCAR-9401': LUCA_ACCOUNTS.RETAINED_EARNINGS,
  'SALE-0001': LUCA_ACCOUNTS.SALES_REVENUE,
  'COST-0101': LUCA_ACCOUNTS.COGS,
  'COST-0601': LUCA_ACCOUNTS.STOCK_WRITE_OFFS,
  'COST-0602': LUCA_ACCOUNTS.STOCK_WRITE_BACK,
  'COST-0401': LUCA_ACCOUNTS.DELIVERY_COSTS_IN,
  'ADMN-3013': LUCA_ACCOUNTS.FX_GAINS_LOSSES,
};

/**
 * Translates an old SMMTA nominal ledger code to the corresponding Luca GL account code.
 * Throws if the code is not mapped.
 */
export function oldCodeToLuca(oldCode: string): string {
  const luca = OLD_TO_LUCA[oldCode];
  if (!luca) {
    throw new Error(`No Luca account mapping for old SMMTA code: ${oldCode}`);
  }
  return luca;
}

/**
 * Accounts that need to be created in Luca before go-live.
 * These do not exist in Luca's default chart of accounts.
 */
export const ACCOUNTS_TO_CREATE = [
  { code: '1150', name: 'Stock (Inventory)', type: 'ASSET' as const, category: 'CURRENT_ASSET' },
  { code: '2310', name: 'GRNI Accrual', type: 'LIABILITY' as const, category: 'CURRENT_LIABILITY' },
  { code: '2320', name: 'Delivery GRNI Accrual', type: 'LIABILITY' as const, category: 'CURRENT_LIABILITY' },
  { code: '2330', name: 'Service GRNI Accrual', type: 'LIABILITY' as const, category: 'CURRENT_LIABILITY' },
  { code: '5010', name: 'Stock Write-Offs', type: 'EXPENSE' as const, category: 'DIRECT_COSTS' },
  { code: '5020', name: 'Stock Write-Back', type: 'EXPENSE' as const, category: 'DIRECT_COSTS' },
  { code: '5030', name: 'Delivery Costs In', type: 'EXPENSE' as const, category: 'DIRECT_COSTS' },
];
