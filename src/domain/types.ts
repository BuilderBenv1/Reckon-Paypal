// Core domain for Reckon. Everything that moves money is described here as plain data
// so the policy engine can stay a set of pure, replayable functions.

export type Currency = 'USD' | 'EUR' | 'GBP';
export type TransferMethod = 'LOCAL' | 'SWIFT';

export type Balances = Record<Currency, number>;

/** Indicative rates: how many USD one unit of each currency buys. */
export type Rates = Record<Currency, number>;

export interface Project {
  job: string;
  name: string;
  customer: string;
  /** Quoted budget in USD. null = no quoted budget (common in real project businesses). */
  budgetUSD: number | null;
  committedCostUSD: number;
}

export interface Payable {
  id: string;
  /** null for overheads that belong to no project. */
  job: string | null;
  supplier: string;
  description: string;
  amount: number;
  currency: Currency;
  /** Days from today. 1 = tomorrow. */
  dueDay: number;
  method: TransferMethod;
  /** Supplier is not yet a known beneficiary. */
  newPayee: boolean;
  /** Supplier has accepted split payments before. */
  acceptsSplit: boolean;
  /** USD cost of pushing this payment back one week (late fees, breached plan, lost discount). */
  deferPenaltyUSD: number;
  /** Receivable this payment unblocks, e.g. freight that lets an install finish and a milestone be invoiced. */
  unlocksReceivableId?: string;
  /** Free text the finance team keeps, e.g. "instalment 3 of 6". */
  note?: string;
}

export type ReceivableStatus = 'invoiced' | 'blocked';

export interface Receivable {
  id: string;
  job: string;
  customer: string;
  milestone: string;
  amount: number;
  currency: Currency;
  status: ReceivableStatus;
  /** Day the cash is expected, from the finance team's sheet. */
  expectedDay: number;
  /** Share of this customer's past invoices paid on time, 0..1. */
  onTimeRate: number;
  /** Customer could be offered an early-payment discount by payment link. */
  earlyPayEligible: boolean;
  customerEmail: string;
}

/** Structured facts the model extracts from an email. Code decides what they mean. */
export type EmailSignal =
  | { kind: 'receipt_delayed'; receivableId: string; newExpectedDay: number; evidence: string }
  | { kind: 'split_accepted'; payableId: string; evidence: string }
  | { kind: 'split_declined'; payableId: string; evidence: string }
  | { kind: 'payment_not_received'; payableId: string; evidence: string }
  | { kind: 'short_payment_explained'; receivableId: string; reason: string; evidence: string }
  | { kind: 'none'; evidence: string };

export interface Email {
  id: string;
  from: string;
  subject: string;
  body: string;
}

export interface Policy {
  version: string;
  reserveFloorUSD: number;
  horizonDays: number;
  swiftFeeEUR: number;
  /** A receipt only counts towards cash if its confidence is at or above this. */
  receiptConfidenceThreshold: number;
  /** Largest FX conversion (USD) the agent may book alone, by forecast confidence. */
  autonomousFxLimitUSD: { high: number; low: number };
  /** Largest single payment (USD) the agent may send alone. */
  autonomousPaymentLimitUSD: number;
  earlyPayDiscount: number;
  /** Largest early-payment discount (USD) the agent may offer alone. */
  autonomousDiscountLimitUSD: number;
  /** Share of a bill paid now when a supplier agrees to split. */
  splitShareNow: number;
  /** Notional relationship cost (USD) of asking a supplier to split. */
  splitAskCostUSD: number;
}

export interface FinanceBook {
  asOf: string;
  projects: Project[];
  payables: Payable[];
  receivables: Receivable[];
}
