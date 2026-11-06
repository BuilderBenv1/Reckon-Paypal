import type { Balances, Currency } from '../domain/types.js';
import type { PayeeDetails } from '../domain/payees.js';
import type { BankPort, FxQuote, PaymentLinkView, SandboxSimulator, TransferStatus, TransferView } from '../bank/port.js';

// The PayPal client. Everything Reckon does with money on PayPal goes through here:
//   cash        GET  /v1/reporting/balances
//   invoices    POST /v2/invoicing/invoices, POST .../{id}/send, POST .../{id}/remind, GET .../{id}
//   payouts     POST /v1/payments/payouts, GET /v1/payments/payouts/{batch_id}
// Field names follow the PayPal REST reference (developer.paypal.com/docs/api). `npm run sandbox:smoke`
// is the check that they still hold against the real sandbox.

export interface WebhookHeaders {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

export const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

type Fetch = typeof fetch;

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  /** Sandbox only: send every payout here (your sandbox personal account) so it lands as SUCCESS. */
  sandboxReceiver?: string;
  fetch?: Fetch;
  now?: () => number;
}

export class PayPalError extends Error {
  constructor(
    readonly status: number,
    readonly name_: string,
    message: string,
    readonly debugId?: string,
  ) {
    super(`${status} ${name_}: ${message}`);
  }
}

interface PayoutItem {
  payout_item_id?: string;
  transaction_status?: string;
  errors?: { name?: string; message?: string };
  payout_item?: { amount?: { value: string; currency: string }; sender_item_id?: string };
}
interface PayoutBatch {
  batch_header: {
    payout_batch_id: string;
    batch_status: string;
    sender_batch_header?: { sender_batch_id?: string };
    amount?: { value: string; currency: string };
  };
  items?: PayoutItem[];
}
interface Invoice {
  id: string;
  status: string;
  detail?: { currency_code?: string; metadata?: { recipient_view_url?: string } };
  amount?: { value?: string; currency_code?: string };
}

/**
 * PayPal payout item states mapped onto Reckon's transfer states. UNCLAIMED and PENDING are
 * still in flight; money that came back (RETURNED, REFUNDED, REVERSED) ends CANCELLED, and a
 * definite failure reads FAILED. Both count as dead, so a replacement is allowed only then.
 */
export function payoutStatus(batchStatus: string, itemStatus?: string): TransferStatus {
  switch (itemStatus) {
    case 'SUCCESS':
      return 'PAID';
    case 'UNCLAIMED':
      return 'SENT';
    case 'PENDING':
    case 'ONHOLD':
      return 'PROCESSING';
    case 'FAILED':
    case 'BLOCKED':
      return 'FAILED';
    case 'RETURNED':
    case 'REFUNDED':
    case 'REVERSED':
      return 'CANCELLED';
  }
  if (batchStatus === 'DENIED' || batchStatus === 'CANCELED') return 'CANCELLED';
  if (batchStatus === 'SUCCESS') return 'PAID';
  return batchStatus === 'PENDING' ? 'CREATED' : 'PROCESSING';
}

/** PayPal treats an invoice as settled once it is PAID or marked paid. */
export const invoicePaid = (status: string) => status === 'PAID' || status === 'MARKED_AS_PAID';

const money = (n: number) => n.toFixed(2);

export class PayPalRest implements BankPort, SandboxSimulator {
  private token: { value: string; expires: number } | null = null;
  private readonly base: string;
  private readonly f: Fetch;
  private readonly now: () => number;
  /** requestId (= sender_batch_id) -> payout_batch_id, kept for lookups after an ambiguous failure. */
  private readonly batches = new Map<string, string>();
  readonly calls: string[] = [];

  constructor(private readonly cfg: PayPalConfig) {
    this.base = (cfg.baseUrl ?? SANDBOX_BASE).replace(/\/$/, '');
    this.f = cfg.fetch ?? fetch;
    this.now = cfg.now ?? Date.now;
  }

  static fromEnv(): PayPalRest {
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox REST app).');
    return new PayPalRest({
      clientId,
      clientSecret,
      baseUrl: process.env.PAYPAL_BASE_URL || SANDBOX_BASE,
      ...(process.env.PAYPAL_SANDBOX_RECEIVER ? { sandboxReceiver: process.env.PAYPAL_SANDBOX_RECEIVER } : {}),
    });
  }

  // ---- plumbing ----

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > this.now() + 60_000) return this.token.value;
    this.calls.push('POST /v1/oauth2/token');
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const res = await this.f(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) throw new PayPalError(res.status, body.error ?? 'AUTH', body.error_description ?? 'could not get an access token');
    this.token = { value: body.access_token, expires: this.now() + (body.expires_in ?? 3000) * 1000 };
    return this.token.value;
  }

  private async call<T>(method: string, path: string, opts: { body?: unknown; label?: string; headers?: Record<string, string> } = {}): Promise<T> {
    this.calls.push(opts.label ?? `${method} ${path.split('?')[0]}`);
    const send = async () =>
      this.f(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          'Content-Type': 'application/json',
          ...opts.headers,
        },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      });
    let res = await send();
    if (res.status === 401) {
      // Token expired early or was revoked: get a new one and try the same request once.
      this.token = null;
      res = await send();
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const details = (json.details as { issue?: string; description?: string }[] | undefined)?.map((d) => d.issue ?? d.description).join(', ');
      throw new PayPalError(res.status, String(json.name ?? 'ERROR'), [json.message, details].filter(Boolean).join(' ') || text.slice(0, 200), json.debug_id as string | undefined);
    }
    return json as T;
  }

  // ---- cash ----

  async balances(): Promise<Balances> {
    const r = await this.call<{ balances?: { currency: string; available_balance?: { value: string }; total_balance?: { value: string } }[] }>(
      'GET',
      '/v1/reporting/balances?currency_code=ALL',
    );
    const out: Balances = { USD: 0, EUR: 0, GBP: 0 };
    for (const b of r.balances ?? []) {
      if (b.currency in out) out[b.currency as Currency] = Number(b.available_balance?.value ?? b.total_balance?.value ?? 0);
    }
    return out;
  }

  // ---- FX: not offered ----

  async quote(): Promise<FxQuote> {
    throw new Error('PayPal has no conversion API. Reckon runs PayPal books in one currency, so the planner never asks for one.');
  }

  async convert(): Promise<{ conversionId: string; status: string }> {
    throw new Error('PayPal has no conversion API.');
  }

  // ---- payouts ----

  /** A PayPal payout goes to an email, so the payee's email is its beneficiary id. */
  async ensureBeneficiary(payee: PayeeDetails): Promise<string> {
    return this.cfg.sandboxReceiver ?? payee.email;
  }

  async createTransfer(args: Parameters<BankPort['createTransfer']>[0]): Promise<TransferView> {
    // sender_batch_id is PayPal's idempotency key for payouts: a second batch with the same id is
    // rejected, so one request id can never pay twice. It is the request id itself.
    const batch = await this.call<PayoutBatch>('POST', '/v1/payments/payouts', {
      headers: { 'PayPal-Request-Id': args.requestId },
      body: {
        sender_batch_header: {
          sender_batch_id: args.requestId,
          email_subject: `Payment ${args.reference}`,
          recipient_type: 'EMAIL',
        },
        items: [
          {
            recipient_type: 'EMAIL',
            amount: { value: money(args.amount), currency: args.currency },
            receiver: args.beneficiaryId,
            note: `${args.reference} (${args.reason.replace(/_/g, ' ')})`,
            sender_item_id: args.reference,
          },
        ],
      },
    });
    const id = batch.batch_header.payout_batch_id;
    this.batches.set(args.requestId, id);
    return {
      id,
      requestId: args.requestId,
      status: payoutStatus(batch.batch_header.batch_status),
      amount: args.amount,
      currency: args.currency,
      reference: args.reference,
    };
  }

  async getTransfer(id: string): Promise<TransferView> {
    const b = await this.call<PayoutBatch>('GET', `/v1/payments/payouts/${encodeURIComponent(id)}`, { label: 'GET /v1/payments/payouts/{id}' });
    const item = b.items?.[0];
    const status = payoutStatus(b.batch_header.batch_status, item?.transaction_status);
    const amount = item?.payout_item?.amount ?? b.batch_header.amount;
    return {
      id: b.batch_header.payout_batch_id,
      requestId: b.batch_header.sender_batch_header?.sender_batch_id ?? '',
      status,
      amount: Number(amount?.value ?? 0),
      currency: (amount?.currency ?? 'USD') as Currency,
      reference: item?.payout_item?.sender_item_id ?? '',
      ...(item?.errors?.name || (status === 'FAILED' || status === 'CANCELLED')
        ? { failureType: item?.errors?.name ?? item?.transaction_status ?? b.batch_header.batch_status }
        : {}),
      ...(item?.errors?.message ? { failureReason: item.errors.message } : {}),
    };
  }

  /**
   * PayPal has no lookup by sender_batch_id. If this process saw the batch id, read it. If not,
   * the batch may or may not exist; report it as in flight so nothing pays again, and leave it
   * for a person. Re-sending is never needed to stay safe: PayPal rejects a repeated batch id.
   */
  async findTransferByRequestId(requestId: string): Promise<TransferView | null> {
    const id = this.batches.get(requestId);
    if (id) return this.getTransfer(id);
    return null;
  }

  // ---- invoices (Reckon's "payment link") ----

  async createPaymentLink(args: { title: string; amount: number; currency: Currency; reference: string; customerEmail?: string }): Promise<PaymentLinkView> {
    const draft = await this.call<Invoice>('POST', '/v2/invoicing/invoices', {
      headers: { Prefer: 'return=representation' },
      body: {
        detail: {
          currency_code: args.currency,
          reference: args.reference,
          note: 'Early payment offer. This invoice replaces the original for this milestone if paid today.',
          payment_term: { term_type: 'DUE_ON_RECEIPT' },
        },
        // PayPal needs the customer on the invoice to send it by email or remind them later.
        ...(args.customerEmail ? { primary_recipients: [{ billing_info: { email_address: args.customerEmail } }] } : {}),
        items: [{ name: args.title.slice(0, 200), quantity: '1', unit_amount: { currency_code: args.currency, value: money(args.amount) } }],
      },
    });
    // Send without PayPal's own email: Reckon's offer email carries the link. notifyShopper()
    // asks PayPal to email the customer as well.
    const sent = await this.call<{ href?: string }>('POST', `/v2/invoicing/invoices/${draft.id}/send`, {
      label: 'POST /v2/invoicing/invoices/{id}/send',
      body: { send_to_recipient: false, send_to_invoicer: false },
    });
    const url = sent?.href ?? (await this.getInvoice(draft.id)).detail?.metadata?.recipient_view_url ?? '';
    return { id: draft.id, url, status: 'UNPAID', amount: args.amount, currency: args.currency };
  }

  /** The invoice was sent without an email; a reminder makes PayPal email the customer. */
  async notifyShopper(linkId: string, email: string): Promise<void> {
    await this.call<void>('POST', `/v2/invoicing/invoices/${linkId}/remind`, {
      label: 'POST /v2/invoicing/invoices/{id}/remind',
      body: { subject: 'Early payment offer', note: `Sent to ${email}` },
    });
  }

  private getInvoice(id: string) {
    return this.call<Invoice>('GET', `/v2/invoicing/invoices/${id}`, { label: 'GET /v2/invoicing/invoices/{id}' });
  }

  async getPaymentLink(id: string): Promise<PaymentLinkView> {
    const inv = await this.getInvoice(id);
    return {
      id: inv.id,
      url: inv.detail?.metadata?.recipient_view_url ?? '',
      status: invoicePaid(inv.status) ? 'PAID' : 'UNPAID',
      amount: Number(inv.amount?.value ?? 0),
      currency: (inv.amount?.currency_code ?? inv.detail?.currency_code ?? 'USD') as Currency,
    };
  }

  // ---- webhooks ----

  /**
   * Asks PayPal whether a webhook delivery is genuine. PayPal signs each delivery; the
   * verify-webhook-signature call checks the signature, cert and webhook id for us.
   */
  async verifyWebhookSignature(h: WebhookHeaders, webhookId: string, event: unknown): Promise<boolean> {
    const r = await this.call<{ verification_status?: string }>('POST', '/v1/notifications/verify-webhook-signature', {
      body: {
        auth_algo: h.authAlgo,
        cert_url: h.certUrl,
        transmission_id: h.transmissionId,
        transmission_sig: h.transmissionSig,
        transmission_time: h.transmissionTime,
        webhook_id: webhookId,
        webhook_event: event,
      },
    });
    return r.verification_status === 'SUCCESS';
  }

  // ---- sandbox simulation ----
  // PayPal's sandbox has no deposit simulator: the operating envelope tracks the story balance.
  // A payout to an email with no PayPal account sits UNCLAIMED, and an unclaimed item can be
  // cancelled, which returns the money (RETURNED). That is how the returned-payment incident runs
  // on the real sandbox, so leave PAYPAL_SANDBOX_RECEIVER unset for the full story.

  async deposit(): Promise<void> {}

  async transitionTransfer(id: string, next: 'SENT' | 'PAID' | 'FAILED'): Promise<void> {
    if (next !== 'FAILED') return; // PayPal moves payouts on its own
    const b = await this.call<PayoutBatch>('GET', `/v1/payments/payouts/${encodeURIComponent(id)}`, { label: 'GET /v1/payments/payouts/{id}' });
    const item = b.items?.[0];
    if (!item?.payout_item_id) throw new Error(`payout ${id} has no item yet`);
    if (item.transaction_status !== 'UNCLAIMED') throw new Error(`payout ${id} is ${item.transaction_status}; only an unclaimed payout can be returned`);
    await this.call('POST', `/v1/payments/payouts-item/${item.payout_item_id}/cancel`, { label: 'POST /v1/payments/payouts-item/{id}/cancel' });
  }

  async payLink(): Promise<void> {
    throw new Error('Pay the PayPal invoice in the browser, signed in as your sandbox personal account.');
  }
}
