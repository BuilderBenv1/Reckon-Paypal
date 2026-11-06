import type { Currency } from '../domain/types.js';

export interface OpenInvoice {
  id: string;
  customer: string;
  amount: number;
  currency: Currency;
  /** Present when the invoice is one instalment of a plan, e.g. 2 of 3. */
  instalment?: { plan: string; n: number; of: number };
}

export interface BankLine {
  id: string;
  date: string;
  payer: string;
  amount: number;
  currency: Currency;
  reference: string;
}

export type MatchKind = 'exact' | 'multi' | 'instalment' | 'fx_difference' | 'short' | 'unmatched';

export interface MatchResult {
  lineId: string;
  kind: MatchKind;
  invoiceIds: string[];
  /** Line amount minus matched invoice total, in the line's currency. */
  difference: number;
  needsPerson: boolean;
  explanation: string;
}

export interface ReconFixture {
  invoices: OpenInvoice[];
  lines: BankLine[];
}
