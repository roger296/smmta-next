/**
 * Xero ManualJournal payload shapes (spec §A8).
 *
 * Internally we model a journal line as a signed `lineAmount` (positive =
 * debit, negative = credit); the client maps that to Xero's `LineAmount`
 * convention (Xero also uses positive=debit / negative=credit, and requires the
 * lines to net to zero).
 */
export interface XeroJournalLine {
  accountCode: string;
  /** Signed: > 0 debit, < 0 credit. */
  lineAmount: number;
  description?: string;
  taxType?: string;
}

export interface XeroManualJournal {
  narration: string;
  /** YYYY-MM-DD */
  date: string;
  reference?: string;
  status: 'DRAFT' | 'POSTED';
  /** ISO currency of the journal (spec §7). Defaults GBP; a USD site posts USD. */
  currencyCode?: string;
  journalLines: XeroJournalLine[];
}

export interface XeroPostResult {
  manualJournalId: string;
}
