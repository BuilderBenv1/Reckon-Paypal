import type { Balances, Currency, Rates } from '../domain/types.js';
import type { PayeeDetails } from '../domain/payees.js';
import type { AirwallexPort, FxQuote, PaymentLinkView, SandboxSimulator, TransferView } from './port.js';

const SWIFT_FEE_EUR = 12.85;

export interface FakeSnapshot {
  wallet: Balances;
  seq: number;
  quotes: [string, FxQuote & { used: boolean }][];
  requestIds: string[];
  transfers: [string, TransferView & { fee: number }][];
  beneficiaries: [string, string][];
  links: [string, PaymentLinkView][];
}
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * In-memory stand-in for the Airwallex sandbox, faithful to the behaviours the builder
 * guide warns about: single-use quotes, SWIFT fees, failed transfers ending CANCELLED,
 * duplicate request ids rejected, and failure types only after SENT.
 */
export class FakeAirwallex implements AirwallexPort, SandboxSimulator {
  private wallet: Balances;
  private seq = 0;
  private quotes = new Map<string, FxQuote & { used: boolean }>();
  private requestIds = new Set<string>();
  private transfers = new Map<string, TransferView & { fee: number }>();
  private beneficiaries = new Map<string, string>();
  private links = new Map<string, PaymentLinkView>();
  readonly calls: string[] = [];

  constructor(balances: Balances, private rates: Rates) {
    this.wallet = { ...balances };
  }

  snapshot(): FakeSnapshot {
    return structuredClone({
      wallet: this.wallet,
      seq: this.seq,
      quotes: [...this.quotes],
      requestIds: [...this.requestIds],
      transfers: [...this.transfers],
      beneficiaries: [...this.beneficiaries],
      links: [...this.links],
    });
  }

  static restore(s: FakeSnapshot, rates: Rates): FakeAirwallex {
    const f = new FakeAirwallex(s.wallet, rates);
    const c = structuredClone(s);
    f.seq = c.seq;
    f.quotes = new Map(c.quotes);
    f.requestIds = new Set(c.requestIds);
    f.transfers = new Map(c.transfers);
    f.beneficiaries = new Map(c.beneficiaries);
    f.links = new Map(c.links);
    return f;
  }

  private id(prefix: string) {
    this.seq += 1;
    return `${prefix}_${this.seq.toString().padStart(4, '0')}`;
  }

  private claim(requestId: string) {
    if (this.requestIds.has(requestId)) throw new Error('duplicate_request_id');
    this.requestIds.add(requestId);
  }

  async balances(): Promise<Balances> {
    this.calls.push('GET /balances/current');
    return { ...this.wallet };
  }

  async quote(sell: Currency, buy: Currency, buyAmount: number): Promise<FxQuote> {
    this.calls.push('POST /fx/quotes/create');
    const clientRate = this.rates[buy] / this.rates[sell];
    const q = { quoteId: this.id('quote'), sellCurrency: sell, buyCurrency: buy, buyAmount, sellAmount: r2(buyAmount * clientRate), clientRate, used: false };
    this.quotes.set(q.quoteId, q);
    const { used: _used, ...out } = q;
    return out;
  }

  async convert({ requestId, quote }: { requestId: string; quote: FxQuote }) {
    this.calls.push('POST /fx/conversions/create');
    const q = this.quotes.get(quote.quoteId);
    if (!q) throw new Error('quote_not_found');
    if (q.used) throw new Error('quote_already_used');
    this.claim(requestId);
    const sellAmount = q.sellAmount;
    if (this.wallet[q.sellCurrency] < sellAmount) throw new Error('insufficient_funds');
    q.used = true;
    this.wallet[q.sellCurrency] = r2(this.wallet[q.sellCurrency] - sellAmount);
    this.wallet[q.buyCurrency] = r2(this.wallet[q.buyCurrency] + q.buyAmount);
    return { conversionId: this.id('conv'), status: 'SETTLED' };
  }

  async ensureBeneficiary(payee: PayeeDetails): Promise<string> {
    this.calls.push('POST /beneficiaries/create');
    const existing = this.beneficiaries.get(payee.supplier);
    if (existing) return existing;
    const id = this.id('ben');
    this.beneficiaries.set(payee.supplier, id);
    return id;
  }

  async createTransfer(args: Parameters<AirwallexPort['createTransfer']>[0]): Promise<TransferView> {
    this.calls.push('POST /transfers/create');
    this.claim(args.requestId);
    const fee = args.method === 'SWIFT' ? SWIFT_FEE_EUR : 0;
    const feeInTransferCcy = args.currency === 'EUR' ? fee : 0;
    if (this.wallet[args.currency] < args.amount + feeInTransferCcy) throw new Error('balance_insufficient');
    if (fee && args.currency !== 'EUR') {
      if (this.wallet.EUR < fee) throw new Error('balance_insufficient');
      this.wallet.EUR = r2(this.wallet.EUR - fee);
    }
    this.wallet[args.currency] = r2(this.wallet[args.currency] - args.amount - feeInTransferCcy);
    const t = { id: this.id('tfr'), requestId: args.requestId, status: 'PROCESSING' as const, amount: args.amount, currency: args.currency, reference: args.reference, fee };
    this.transfers.set(t.id, t);
    return view(t);
  }

  async getTransfer(id: string): Promise<TransferView> {
    this.calls.push('GET /transfers/{id}');
    const t = this.transfers.get(id);
    if (!t) throw new Error('transfer_not_found');
    return view(t);
  }

  async findTransferByRequestId(requestId: string): Promise<TransferView | null> {
    this.calls.push('GET /transfers');
    const t = [...this.transfers.values()].find((x) => x.requestId === requestId);
    return t ? view(t) : null;
  }

  async createPaymentLink(args: { title: string; amount: number; currency: Currency; reference: string }): Promise<PaymentLinkView> {
    this.calls.push('POST /pa/payment_links/create');
    const id = this.id('plink');
    const link: PaymentLinkView = { id, url: `https://pay.sandbox.example/${id}`, status: 'UNPAID', amount: args.amount, currency: args.currency };
    this.links.set(id, link);
    return { ...link };
  }

  async notifyShopper(linkId: string): Promise<void> {
    this.calls.push('POST /pa/payment_links/{id}/notify_shopper');
    if (!this.links.has(linkId)) throw new Error('link_not_found');
  }

  async getPaymentLink(id: string): Promise<PaymentLinkView> {
    this.calls.push('GET /pa/payment_links/{id}');
    const l = this.links.get(id);
    if (!l) throw new Error('link_not_found');
    return { ...l };
  }

  // ---- sandbox simulation ----

  async deposit(amount: number, currency: Currency): Promise<void> {
    this.calls.push('POST /simulation/deposit/create');
    this.wallet[currency] = r2(this.wallet[currency] + amount);
  }

  async transitionTransfer(id: string, next: 'SENT' | 'PAID' | 'FAILED', failureType?: string): Promise<void> {
    this.calls.push('POST /simulation/transfers/{id}/transition');
    const t = this.transfers.get(id);
    if (!t) throw new Error('transfer_not_found');
    if (next === 'FAILED') {
      if (failureType && t.status !== 'SENT') throw new Error('failure_type only applies after SENT');
      // Airwallex auto-cancels a failed transfer and returns the funds.
      t.status = 'CANCELLED';
      t.failureType = failureType ?? 'UNKNOWN';
      t.failureReason = failureType ? `Simulated ${failureType.toLowerCase().replace(/_/g, ' ')}` : 'simulation';
      const feeInTransferCcy = t.currency === 'EUR' ? t.fee : 0;
      this.wallet[t.currency] = r2(this.wallet[t.currency] + t.amount + feeInTransferCcy);
      return;
    }
    t.status = next;
  }

  async payLink(linkId: string): Promise<void> {
    const l = this.links.get(linkId);
    if (!l) throw new Error('link_not_found');
    l.status = 'PAID';
    this.wallet[l.currency] = r2(this.wallet[l.currency] + l.amount);
  }
}

const view = (t: TransferView & { fee: number }): TransferView => {
  const { fee: _fee, ...rest } = t;
  return { ...rest };
};
