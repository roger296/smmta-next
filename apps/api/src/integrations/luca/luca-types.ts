/**
 * Types for the Luca General Ledger REST API.
 * These mirror the gl_post_transaction MCP tool parameters.
 */

export interface LucaPostTransactionRequest {
  transaction_type: string;
  date: string;       // YYYY-MM-DD
  period_id: string;  // YYYY-MM
  description?: string;
  reference?: string;
  amount?: number;
  account_code?: string;
  tax_code?: string;
  counterparty?: {
    name: string;
    id?: string;
  };
  lines?: LucaJournalLine[];
  idempotency_key?: string;
  submitted_by?: string;
  soft_close_override?: boolean;
}

export interface LucaJournalLine {
  account_code: string;
  amount: string;
  type: 'DEBIT' | 'CREDIT';
  description?: string;
}

export interface LucaPostTransactionResponse {
  transaction_id: string;
  status: string;
  [key: string]: unknown;
}

export interface LucaPeriodStatusResponse {
  period_id: string;
  status: 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE';
  [key: string]: unknown;
}

export interface LucaAccountBalance {
  account_code: string;
  balance: string;
  [key: string]: unknown;
}

export interface LucaYearEndCloseRequest {
  financial_year_end: string;     // YYYY-MM
  new_year_first_period: string;  // YYYY-MM
}
