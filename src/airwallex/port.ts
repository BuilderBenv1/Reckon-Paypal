import type { Balances, Currency, TransferMethod } from '../domain/types.js';
import type { PayeeDetails } from '../domain/payees.js';

// Everything Reckon needs from Airwallex, behind one interface. The planner never sees this;
// the agent calls it only to carry out decisions the policy engine has already allowed.

/**
 * Airwallex transfer states. A failed transfer ends CANCELLED, but can read FAILED for a few
 * seconds first, so code treats both as a definite failure.
 */
export type TransferStatus = 'CREATED' | 'PROCESSING' | 'SENT' | 'PAID' | 'FAILED' | 'CANCELLED';

export const isDeadTransfer = (s: TransferStatus | string) => s === 'FAILED' || s === 'CANCELLED';

export interface TransferView {
  id: string;
  requestId: string;
  status: TransferStatus;
  amount: number;
  currency: Currency;
  reference: string;
  failureType?: string;
  failureReason?: string;
}

export interface FxQuote {
  quoteId: string;
  sellCurrency: Currency;
  buyCurrency: Currency;
  buyAmount: number;
  /** What the conversion will take from the sell currency. */
  sellAmount: number;
  clientRate: number;
}

export interface PaymentLinkView {
  id: string;
  url: string;
  status: 'UNPAID' | 'PAID';
  amount: number;
  currency: Currency;
}

export interface AirwallexPort {
  balances(): Promise<Balances>;
  /** Single-use: book a quote once, get a fresh one to convert again. */
  quote(sell: Currency, buy: Currency, buyAmount: number): Promise<FxQuote>;
  convert(args: { requestId: string; quote: FxQuote }): Promise<{ conversionId: string; status: string }>;
  ensureBeneficiary(payee: PayeeDetails): Promise<string>;
  createTransfer(args: {
    requestId: string;
    beneficiaryId: string;
    amount: number;
    currency: Currency;
    method: TransferMethod;
    reference: string;
    reason: string;
  }): Promise<TransferView>;
  getTransfer(id: string): Promise<TransferView>;
  /** Find a transfer by our request id, used before any retry so a retry can never pay twice. */
  findTransferByRequestId(requestId: string): Promise<TransferView | null>;
  createPaymentLink(args: { title: string; amount: number; currency: Currency; reference: string }): Promise<PaymentLinkView>;
  notifyShopper(linkId: string, email: string): Promise<void>;
  getPaymentLink(id: string): Promise<PaymentLinkView>;
}

/** Sandbox-only calls, kept apart so the decision logic never depends on them. */
export interface SandboxSimulator {
  deposit(amount: number, currency: Currency, payerName: string): Promise<void>;
  transitionTransfer(id: string, next: 'SENT' | 'PAID' | 'FAILED', failureType?: string): Promise<void>;
  payLink(linkId: string): Promise<void>;
}
