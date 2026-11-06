import type { Balances, Currency } from '../domain/types.js';
import type { PayeeDetails } from '../domain/payees.js';
import type { AirwallexPort, FxQuote, PaymentLinkView, SandboxSimulator, TransferStatus, TransferView } from './port.js';

// REST client for the Airwallex sandbox, written from the hackathon builder guide.
// Field names checked against the Airwallex API reference on 23 Oct 2026 (links per method).
// `npm run sandbox:smoke` confirms them against a live sandbox.
//
// Conventions from the guide:
// - Base URL https://api.sandbox.airwallex.com, paths under /api/v1
// - Login with x-client-id + x-api-key headers, no body; bearer token lasts 30 minutes
// - Amounts in major units; request_id is a UUID reused only for a retry of the same operation
// - No x-api-version on FX calls; FX conversions are REST-only (no MCP tool)

const TOKEN_TTL_MS = 25 * 60 * 1000; // re-login before the 30-minute expiry

export class AirwallexRest implements AirwallexPort, SandboxSimulator {
  private token: { value: string; at: number } | null = null;

  constructor(
    private readonly cfg: { baseUrl: string; clientId: string; apiKey: string },
    private readonly now: () => number = Date.now,
  ) {}

  static fromEnv(): AirwallexRest {
    const clientId = process.env.AWX_CLIENT_ID;
    const apiKey = process.env.AWX_API_KEY;
    if (!clientId || !apiKey) throw new Error('Set AWX_CLIENT_ID and AWX_API_KEY in .env (sandbox keys only).');
    return new AirwallexRest({ baseUrl: process.env.AWX_BASE_URL ?? 'https://api.sandbox.airwallex.com', clientId, apiKey });
  }

  private async auth(): Promise<string> {
    if (this.token && this.now() - this.token.at < TOKEN_TTL_MS) return this.token.value;
    const res = await fetch(`${this.cfg.baseUrl}/api/v1/authentication/login`, {
      method: 'POST',
      headers: { 'x-client-id': this.cfg.clientId, 'x-api-key': this.cfg.apiKey },
    });
    if (!res.ok) throw new AirwallexError('login', res.status, await res.text());
    const body = (await res.json()) as { token: string };
    this.token = { value: body.token, at: this.now() };
    return body.token;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, attempt = 0): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.auth()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && attempt === 0) {
      this.token = null;
      return this.call(method, path, body, 1);
    }
    if (res.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      return this.call(method, path, body, attempt + 1);
    }
    const text = await res.text();
    if (!res.ok) throw new AirwallexError(`${method} ${path}`, res.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async balances(): Promise<Balances> {
    const rows = await this.call<{ currency: string; available_amount: number }[]>('GET', '/balances/current');
    const out: Balances = { USD: 0, EUR: 0, GBP: 0 };
    for (const r of rows) if (r.currency in out) out[r.currency as Currency] = r.available_amount;
    return out;
  }

  async quote(sell: Currency, buy: Currency, buyAmount: number): Promise<FxQuote> {
    // https://www.airwallex.com/docs/api/transactional_fx/quotes/create (buy_amount is a number here)
    const q = await this.call<{ quote_id: string; client_rate: number; sell_amount: number }>('POST', '/fx/quotes/create', {
      sell_currency: sell,
      buy_currency: buy,
      buy_amount: Math.round(buyAmount * 100) / 100,
      validity: 'MIN_1',
    });
    return { quoteId: q.quote_id, sellCurrency: sell, buyCurrency: buy, buyAmount, sellAmount: Number(q.sell_amount), clientRate: q.client_rate };
  }

  async convert({ requestId, quote }: { requestId: string; quote: FxQuote }) {
    // https://www.airwallex.com/docs/api/transactional_fx/conversion/create (buy_amount is a string here)
    const c = await this.call<{ conversion_id?: string; id?: string; status: string }>('POST', '/fx/conversions/create', {
      request_id: requestId,
      buy_currency: quote.buyCurrency,
      sell_currency: quote.sellCurrency,
      buy_amount: quote.buyAmount.toFixed(2),
      quote_id: quote.quoteId,
    });
    return { conversionId: c.conversion_id ?? c.id ?? '', status: c.status };
  }

  async ensureBeneficiary(payee: PayeeDetails): Promise<string> {
    const bank_details =
      payee.bank.kind === 'US'
        ? { account_name: payee.supplier, account_currency: 'USD', bank_country_code: 'US', account_number: payee.bank.account_number, account_routing_type1: 'aba', account_routing_value1: payee.bank.aba, bank_account_category: payee.bank.bank_account_category }
        : payee.bank.kind === 'GB'
          ? { account_name: payee.supplier, account_currency: 'GBP', bank_country_code: 'GB', account_number: payee.bank.account_number, account_routing_type1: 'sort_code', account_routing_value1: payee.bank.sort_code, bank_name: payee.bank.bank_name }
          : { account_name: payee.supplier, account_currency: 'EUR', bank_country_code: 'DE', iban: payee.bank.iban, swift_code: payee.bank.swift_code };
    // https://www.airwallex.com/docs/api/payouts/beneficiaries/create (no request_id; id returned top-level)
    const b = await this.call<{ id?: string; beneficiary_id?: string }>('POST', '/beneficiaries/create', {
      nickname: payee.supplier,
      beneficiary: {
        entity_type: 'COMPANY',
        company_name: payee.supplier,
        address: payee.address,
        bank_details,
      },
      transfer_methods: [payee.method],
    });
    return b.beneficiary_id ?? b.id ?? '';
  }

  async createTransfer(args: Parameters<AirwallexPort['createTransfer']>[0]): Promise<TransferView> {
    // https://www.airwallex.com/docs/api/payouts/transfers/create
    // Guide: send transfer_currency and transfer_amount (payment_currency returns code 001).
    // `reason` is a closed list (freight, construction, goods_purchased, technical_services, ...).
    const t = await this.call<RawTransfer>('POST', '/transfers/create', {
      request_id: args.requestId,
      beneficiary_id: args.beneficiaryId,
      transfer_amount: args.amount.toFixed(2),
      transfer_currency: args.currency,
      source_currency: args.currency,
      transfer_method: args.method,
      reference: args.reference.slice(0, 35),
      reason: args.reason,
    });
    return toView(t);
  }

  async getTransfer(id: string): Promise<TransferView> {
    return toView(await this.call<RawTransfer>('GET', `/transfers/${id}`));
  }

  async findTransferByRequestId(requestId: string): Promise<TransferView | null> {
    // https://www.airwallex.com/docs/api/payouts/transfers/list (request_id is a query parameter)
    const page = await this.call<{ items: RawTransfer[] }>('GET', `/transfers?request_id=${encodeURIComponent(requestId)}`);
    const hit = page.items?.find((t) => t.request_id === requestId);
    return hit ? toView(hit) : null;
  }

  async createPaymentLink(args: { title: string; amount: number; currency: Currency; reference: string }): Promise<PaymentLinkView> {
    const l = await this.call<{ id: string; url: string; status: 'UNPAID' | 'PAID' }>('POST', '/pa/payment_links/create', {
      // https://www.airwallex.com/docs/api/payments/payment_links/create (amount is a number)
      title: args.title,
      amount: Math.round(args.amount * 100) / 100,
      currency: args.currency,
      reusable: false,
      reference: args.reference,
    });
    return { id: l.id, url: l.url, status: l.status ?? 'UNPAID', amount: args.amount, currency: args.currency };
  }

  async notifyShopper(linkId: string, email: string): Promise<void> {
    // https://www.airwallex.com/docs/api/payments/payment_links/notify_shopper
    await this.call('POST', `/pa/payment_links/${linkId}/notify_shopper`, { shopper_email: email });
  }

  async getPaymentLink(id: string): Promise<PaymentLinkView> {
    const l = await this.call<{ id: string; url: string; status: 'UNPAID' | 'PAID'; amount: number; currency: Currency }>('GET', `/pa/payment_links/${id}`);
    return { id: l.id, url: l.url, status: l.status, amount: Number(l.amount), currency: l.currency };
  }

  // ---- sandbox simulation ----

  async deposit(amount: number, currency: Currency, payerName: string): Promise<void> {
    // The deposit lands in the Global Account's currency; pick an account in `currency`.
    const acct = await this.globalAccount(currency);
    if (!acct) throw new Error(`No active ${currency} Global Account in the sandbox; run npm run sandbox:smoke to create one.`);
    await this.call('POST', '/simulation/deposit/create', { global_account_id: acct.id, amount, payer_name: payerName });
  }

  async transitionTransfer(id: string, next: 'SENT' | 'PAID' | 'FAILED', failureType?: string): Promise<void> {
    // https://www.airwallex.com/docs/api/simulation/transfers
    // Guide: simulate SENT before PAID. failure_type values include ACCOUNT_CLOSED,
    // BENEFICIARY_BANK_RETURNED, INVALID_ACCOUNT_NAME_OR_NUMBER, RECALL_REQUESTED.
    await this.call('POST', `/simulation/transfers/${id}/transition`, failureType ? { next_status: next, failure_type: failureType } : { next_status: next });
  }

  /** First ACTIVE Global Account holding `currency`, or null. */
  async globalAccount(currency: Currency): Promise<{ id: string } | null> {
    // https://www.airwallex.com/docs/api/core_resources/global_accounts/list
    type Acct = { id: string; status: string; required_features?: { currency: string }[]; supported_features?: { currency: string }[] };
    const page = await this.call<{ items: Acct[] }>('GET', '/global_accounts');
    const has = (a: Acct) => [...(a.required_features ?? []), ...(a.supported_features ?? [])].some((f) => f.currency === currency);
    return page.items?.find((a) => a.status === 'ACTIVE' && has(a)) ?? null;
  }

  /** Creates a LOCAL Global Account. country_code is the account country, not the currency. */
  async createGlobalAccount(currency: Currency): Promise<{ id: string }> {
    const country = { USD: 'US', EUR: 'NL', GBP: 'GB' }[currency];
    return this.call<{ id: string }>('POST', '/global_accounts/create', {
      request_id: crypto.randomUUID(),
      country_code: country,
      required_features: [{ currency, transfer_method: 'LOCAL' }],
    });
  }

  async payLink(): Promise<void> {
    throw new Error('In the live sandbox, open the payment link and pay with test card 4035501000000008 (any future expiry, any CVC).');
  }
}

interface RawTransfer {
  id: string;
  request_id: string;
  status: string;
  transfer_amount: number | string;
  transfer_currency: Currency;
  reference: string;
  failure_type?: string;
  failure_reason?: string;
  /** Where the API reference puts failure details. */
  failure?: { code?: string; message?: string; details?: { type?: string } };
}

function toView(t: RawTransfer): TransferView {
  const v: TransferView = {
    id: t.id,
    requestId: t.request_id,
    status: t.status as TransferStatus,
    amount: Number(t.transfer_amount),
    currency: t.transfer_currency,
    reference: t.reference,
  };
  const failureType = t.failure?.details?.type ?? t.failure_type;
  const failureReason = t.failure?.message ?? t.failure_reason;
  if (failureType) v.failureType = failureType;
  if (failureReason) v.failureReason = failureReason;
  return v;
}

export class AirwallexError extends Error {
  constructor(readonly op: string, readonly status: number, readonly body: string) {
    super(`Airwallex ${op} failed (${status}): ${body.slice(0, 300)}`);
  }
}
