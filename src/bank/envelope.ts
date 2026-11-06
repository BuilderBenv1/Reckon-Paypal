import type { Balances, Currency } from '../domain/types.js';
import type { PayeeDetails } from '../domain/payees.js';
import { isDeadTransfer, type BankPort, type FxQuote, type PaymentLinkView, type SandboxSimulator, type TransferView } from './port.js';

const SWIFT_FEE_EUR = 12.85;

export interface EnvelopeSnapshot {
  wallet: Balances;
  refunded: string[];
  credited: string[];
  beneficiaries: [string, string][];
  transferMeta: [string, { amount: number; currency: Currency; swift: boolean }][];
}
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Real PayPal calls, story-sized balances.
 *
 * A sandbox business account can hold far more than the story's business, so the agent would
 * never see a cash gap. This wrapper sends every call to the real sandbox but reports an operating balance that
 * starts at the business's story figures and moves with each real payout, returned payout
 * and paid invoice. The planner reasons over the envelope; the sandbox
 * records the real money movements.
 */
export class OperatingEnvelope implements BankPort, SandboxSimulator {
  private wallet: Balances;
  private refunded = new Set<string>();
  private credited = new Set<string>();
  private beneficiaries = new Map<string, string>();
  private transferMeta = new Map<string, { amount: number; currency: Currency; swift: boolean }>();
  readonly calls: string[] = [];

  constructor(private readonly inner: BankPort & SandboxSimulator, start: Balances) {
    this.wallet = { ...start };
  }

  snapshot(): EnvelopeSnapshot {
    return structuredClone({
      wallet: this.wallet,
      refunded: [...this.refunded],
      credited: [...this.credited],
      beneficiaries: [...this.beneficiaries],
      transferMeta: [...this.transferMeta],
    });
  }

  static restore(inner: BankPort & SandboxSimulator, s: EnvelopeSnapshot): OperatingEnvelope {
    const e = new OperatingEnvelope(inner, s.wallet);
    const c = structuredClone(s);
    e.refunded = new Set(c.refunded);
    e.credited = new Set(c.credited);
    e.beneficiaries = new Map(c.beneficiaries);
    e.transferMeta = new Map(c.transferMeta);
    return e;
  }

  async balances(): Promise<Balances> {
    this.calls.push('GET /v1/reporting/balances');
    await this.inner.balances(); // keeps the real call in the trail
    return { ...this.wallet };
  }

  quote(sell: Currency, buy: Currency, buyAmount: number): Promise<FxQuote> {
    this.calls.push('POST /fx/quotes/create');
    return this.inner.quote(sell, buy, buyAmount);
  }

  async convert(args: { requestId: string; quote: FxQuote }) {
    this.calls.push('POST /fx/conversions/create');
    const { quote } = args;
    if (this.wallet[quote.sellCurrency] < quote.sellAmount) throw new Error('insufficient_funds (operating balance)');
    const out = await this.inner.convert(args);
    this.wallet[quote.sellCurrency] = r2(this.wallet[quote.sellCurrency] - quote.sellAmount);
    this.wallet[quote.buyCurrency] = r2(this.wallet[quote.buyCurrency] + quote.buyAmount);
    return out;
  }

  async ensureBeneficiary(payee: PayeeDetails): Promise<string> {
    const cached = this.beneficiaries.get(payee.supplier);
    if (cached) return cached;
    this.calls.push('payee email');
    const id = await this.inner.ensureBeneficiary(payee);
    this.beneficiaries.set(payee.supplier, id);
    return id;
  }

  async createTransfer(args: Parameters<BankPort['createTransfer']>[0]): Promise<TransferView> {
    this.calls.push('POST /v1/payments/payouts');
    const swift = args.method === 'SWIFT';
    const feeSame = swift && args.currency === 'EUR' ? SWIFT_FEE_EUR : 0;
    const feeEUR = swift && args.currency !== 'EUR' ? SWIFT_FEE_EUR : 0;
    if (this.wallet[args.currency] < args.amount + feeSame || this.wallet.EUR < feeEUR) {
      throw new Error('balance_insufficient (operating balance)');
    }
    const t = await this.inner.createTransfer(args);
    this.wallet[args.currency] = r2(this.wallet[args.currency] - args.amount - feeSame);
    this.wallet.EUR = r2(this.wallet.EUR - feeEUR);
    this.transferMeta.set(t.id, { amount: args.amount, currency: args.currency, swift });
    return t;
  }

  async getTransfer(id: string): Promise<TransferView> {
    this.calls.push('GET /v1/payments/payouts/{id}');
    const t = await this.inner.getTransfer(id);
    this.refundIfCancelled(t);
    return t;
  }

  async findTransferByRequestId(requestId: string): Promise<TransferView | null> {
    this.calls.push('payout lookup by sender_batch_id');
    const t = await this.inner.findTransferByRequestId(requestId);
    if (t) this.refundIfCancelled(t);
    return t;
  }

  /** A failed or cancelled transfer's money comes back to the wallet once. */
  private refundIfCancelled(t: TransferView) {
    const meta = this.transferMeta.get(t.id);
    if (!isDeadTransfer(t.status) || !meta || this.refunded.has(t.id)) return;
    this.refunded.add(t.id);
    const fee = meta.swift ? SWIFT_FEE_EUR : 0;
    this.wallet[meta.currency] = r2(this.wallet[meta.currency] + meta.amount + (meta.currency === 'EUR' ? fee : 0));
    if (meta.currency !== 'EUR') this.wallet.EUR = r2(this.wallet.EUR + fee);
  }

  createPaymentLink(args: { title: string; amount: number; currency: Currency; reference: string; customerEmail?: string }): Promise<PaymentLinkView> {
    this.calls.push('POST /v2/invoicing/invoices');
    return this.inner.createPaymentLink(args);
  }

  notifyShopper(linkId: string, email: string): Promise<void> {
    this.calls.push('POST /v2/invoicing/invoices/{id}/remind');
    return this.inner.notifyShopper(linkId, email);
  }

  async getPaymentLink(id: string): Promise<PaymentLinkView> {
    this.calls.push('GET /v2/invoicing/invoices/{id}');
    const l = await this.inner.getPaymentLink(id);
    if (l.status === 'PAID' && !this.credited.has(id)) {
      this.credited.add(id);
      this.wallet[l.currency] = r2(this.wallet[l.currency] + l.amount);
    }
    return l;
  }

  async deposit(amount: number, currency: Currency, payerName: string): Promise<void> {
    this.calls.push('opening balance');
    await this.inner.deposit(amount, currency, payerName);
    this.wallet[currency] = r2(this.wallet[currency] + amount);
  }

  transitionTransfer(id: string, next: 'SENT' | 'PAID' | 'FAILED', failureType?: string): Promise<void> {
    this.calls.push('POST /v1/payments/payouts-item/{id}/cancel');
    return this.inner.transitionTransfer(id, next, failureType);
  }

  payLink(linkId: string): Promise<void> {
    return this.inner.payLink(linkId);
  }
}
