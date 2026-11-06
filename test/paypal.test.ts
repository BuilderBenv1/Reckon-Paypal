import { describe, expect, it } from 'vitest';
import { PayPalRest, payoutStatus, invoicePaid, PayPalError } from '../src/paypal/rest.js';
import { payees } from '../src/domain/payees.js';

// A scripted PayPal: each route answers from a handler, and every request is recorded so the
// tests can check exactly what Reckon sent.
type Handler = (req: { method: string; url: string; headers: Record<string, string>; body: any }) => { status?: number; json?: unknown };

function mockPayPal(routes: Record<string, Handler>) {
  const sent: { method: string; path: string; headers: Record<string, string>; body: any }[] = [];
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const raw = typeof init.body === 'string' ? init.body : undefined;
    const body = raw && headers['Content-Type'] === 'application/json' ? JSON.parse(raw) : raw;
    sent.push({ method, path: url.pathname + url.search, headers, body });
    if (url.pathname === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && new RegExp(`^${p!.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(url.pathname);
    });
    if (!key) return new Response(JSON.stringify({ name: 'NOT_FOUND', message: `${method} ${url.pathname}` }), { status: 404 });
    const out = routes[key]!({ method, url: url.toString(), headers, body });
    return new Response(out.json === undefined ? null : JSON.stringify(out.json), { status: out.status ?? 200 });
  }) as typeof fetch;
  const pp = new PayPalRest({ clientId: 'id', clientSecret: 'secret', fetch: f, now: () => 0 });
  return { pp, sent };
}

describe('PayPal client', () => {
  it('reads available USD from the reporting balances API', async () => {
    const { pp, sent } = mockPayPal({
      'GET /v1/reporting/balances': () => ({
        json: { balances: [{ currency: 'USD', primary: true, total_balance: { value: '20000.00' }, available_balance: { value: '18420.50' } }] },
      }),
    });
    expect(await pp.balances()).toEqual({ USD: 18420.5, EUR: 0, GBP: 0 });
    expect(sent.at(-1)!.path).toBe('/v1/reporting/balances?currency_code=ALL');
    expect(sent.at(-1)!.headers.Authorization).toBe('Bearer tok');
  });

  it('gets one token and reuses it', async () => {
    const { pp, sent } = mockPayPal({ 'GET /v1/reporting/balances': () => ({ json: { balances: [] } }) });
    await pp.balances();
    await pp.balances();
    expect(sent.filter((s) => s.path === '/v1/oauth2/token')).toHaveLength(1);
    expect(sent[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`);
  });

  it('sends a payout with the request id as sender_batch_id, in major units', async () => {
    const { pp, sent } = mockPayPal({
      'POST /v1/payments/payouts': () => ({ status: 201, json: { batch_header: { payout_batch_id: 'BATCH1', batch_status: 'PENDING' } } }),
    });
    const t = await pp.createTransfer({
      requestId: 'req-1', beneficiaryId: 'supplier@example.com', amount: 2032.5, currency: 'USD', method: 'LOCAL', reference: 'PAY-121-COMP', reason: 'goods_purchased',
    });
    const body = sent.at(-1)!.body;
    expect(body.sender_batch_header.sender_batch_id).toBe('req-1');
    expect(sent.at(-1)!.headers['PayPal-Request-Id']).toBe('req-1');
    expect(body.items[0]).toMatchObject({ recipient_type: 'EMAIL', receiver: 'supplier@example.com', amount: { value: '2032.50', currency: 'USD' }, sender_item_id: 'PAY-121-COMP' });
    expect(t).toMatchObject({ id: 'BATCH1', requestId: 'req-1', status: 'CREATED', amount: 2032.5 });
  });

  it('pays the payee email, or the sandbox receiver when one is set', async () => {
    const { pp } = mockPayPal({});
    expect(await pp.ensureBeneficiary(payees['Planwise Software Inc']!)).toBe('billing@planwise.example');
    const routed = new PayPalRest({ clientId: 'a', clientSecret: 'b', sandboxReceiver: 'buyer@personal.example', fetch: fetch });
    expect(await routed.ensureBeneficiary(payees['Planwise Software Inc']!)).toBe('buyer@personal.example');
  });

  it('reads a payout item state and failure', async () => {
    const { pp } = mockPayPal({
      'GET /v1/payments/payouts/{id}': () => ({
        json: {
          batch_header: { payout_batch_id: 'BATCH1', batch_status: 'SUCCESS', sender_batch_header: { sender_batch_id: 'req-1' } },
          items: [{ payout_item_id: 'ITEM1', transaction_status: 'RETURNED', errors: { name: 'RECEIVER_UNREGISTERED', message: 'Receiver has no PayPal account' }, payout_item: { amount: { value: '2500.00', currency: 'USD' }, sender_item_id: 'PAY-109-SUB' } }],
        },
      }),
    });
    expect(await pp.getTransfer('BATCH1')).toEqual({
      id: 'BATCH1', requestId: 'req-1', status: 'CANCELLED', amount: 2500, currency: 'USD', reference: 'PAY-109-SUB',
      failureType: 'RECEIVER_UNREGISTERED', failureReason: 'Receiver has no PayPal account',
    });
  });

  it('maps payout states so only definite failures allow a replacement', () => {
    expect(payoutStatus('SUCCESS', 'SUCCESS')).toBe('PAID');
    expect(payoutStatus('SUCCESS', 'UNCLAIMED')).toBe('SENT');
    expect(payoutStatus('PROCESSING', 'PENDING')).toBe('PROCESSING');
    expect(payoutStatus('SUCCESS', 'FAILED')).toBe('FAILED');
    expect(payoutStatus('SUCCESS', 'RETURNED')).toBe('CANCELLED');
    expect(payoutStatus('DENIED')).toBe('CANCELLED');
    expect(payoutStatus('PENDING')).toBe('CREATED');
  });

  it('finds a payout by request id only if it saw the batch id; never guesses', async () => {
    const { pp } = mockPayPal({
      'POST /v1/payments/payouts': () => ({ status: 201, json: { batch_header: { payout_batch_id: 'BATCH9', batch_status: 'PENDING' } } }),
      'GET /v1/payments/payouts/{id}': () => ({ json: { batch_header: { payout_batch_id: 'BATCH9', batch_status: 'PROCESSING' }, items: [{ transaction_status: 'PENDING' }] } }),
    });
    expect(await pp.findTransferByRequestId('never-sent')).toBeNull();
    await pp.createTransfer({ requestId: 'req-9', beneficiaryId: 'x@example.com', amount: 10, currency: 'USD', method: 'LOCAL', reference: 'R', reason: 'freight' });
    expect((await pp.findTransferByRequestId('req-9'))!.status).toBe('PROCESSING');
  });

  it('surfaces a duplicate batch as an error instead of paying again', async () => {
    const { pp } = mockPayPal({
      'POST /v1/payments/payouts': () => ({ status: 400, json: { name: 'USER_BUSINESS_ERROR', message: 'Batch with given sender_batch_id already exists', debug_id: 'abc' } }),
    });
    await expect(pp.createTransfer({ requestId: 'req-1', beneficiaryId: 'x@example.com', amount: 10, currency: 'USD', method: 'LOCAL', reference: 'R', reason: 'freight' })).rejects.toBeInstanceOf(PayPalError);
  });

  it('creates and sends an early-pay invoice, returning the payer link', async () => {
    const { pp, sent } = mockPayPal({
      'POST /v2/invoicing/invoices': () => ({ status: 201, json: { id: 'INV2-AAAA', status: 'DRAFT' } }),
      'POST /v2/invoicing/invoices/{id}/send': () => ({ json: { rel: 'payer-view', href: 'https://www.sandbox.paypal.com/invoice/p/#INV2-AAAA', method: 'GET' } }),
    });
    const link = await pp.createPaymentLink({ title: 'Calder & Finch LLP: Stage 2', amount: 11820, currency: 'USD', reference: 'REC-121-INV' });
    expect(link).toEqual({ id: 'INV2-AAAA', url: 'https://www.sandbox.paypal.com/invoice/p/#INV2-AAAA', status: 'UNPAID', amount: 11820, currency: 'USD' });
    const create = sent.find((s) => s.path === '/v2/invoicing/invoices')!;
    expect(create.headers.Prefer).toBe('return=representation');
    expect(create.body.items[0].unit_amount).toEqual({ currency_code: 'USD', value: '11820.00' });
    expect(create.body.detail.reference).toBe('REC-121-INV');
    expect(sent.find((s) => s.path.endsWith('/send'))!.body).toEqual({ send_to_recipient: false, send_to_invoicer: false });
  });

  it('falls back to the invoice metadata for the payer link', async () => {
    const { pp } = mockPayPal({
      'POST /v2/invoicing/invoices': () => ({ status: 201, json: { id: 'INV2-B', status: 'DRAFT' } }),
      'POST /v2/invoicing/invoices/{id}/send': () => ({ status: 202, json: {} }),
      'GET /v2/invoicing/invoices/{id}': () => ({ json: { id: 'INV2-B', status: 'SENT', detail: { metadata: { recipient_view_url: 'https://www.sandbox.paypal.com/invoice/p/#INV2-B' } } } }),
    });
    expect((await pp.createPaymentLink({ title: 't', amount: 1, currency: 'USD', reference: 'r' })).url).toBe('https://www.sandbox.paypal.com/invoice/p/#INV2-B');
  });

  it('reads an invoice as PAID once PayPal says so', async () => {
    let status = 'SENT';
    const { pp } = mockPayPal({
      'GET /v2/invoicing/invoices/{id}': () => ({ json: { id: 'INV2-A', status, amount: { value: '11820.00', currency_code: 'USD' } } }),
    });
    expect((await pp.getPaymentLink('INV2-A')).status).toBe('UNPAID');
    status = 'PAID';
    expect(await pp.getPaymentLink('INV2-A')).toMatchObject({ status: 'PAID', amount: 11820, currency: 'USD' });
    expect(invoicePaid('MARKED_AS_PAID')).toBe(true);
  });

  it('asks PayPal to email the customer with a reminder', async () => {
    const { pp, sent } = mockPayPal({ 'POST /v2/invoicing/invoices/{id}/remind': () => ({ status: 204 }) });
    await pp.notifyShopper('INV2-A', 'payables@calderfinch.example');
    expect(sent.at(-1)!.body.additional_recipients).toEqual(['payables@calderfinch.example']);
  });

  it('returns an unclaimed payout for the incident, and refuses anything else', async () => {
    let item = { payout_item_id: 'ITEM1', transaction_status: 'UNCLAIMED' };
    const { pp, sent } = mockPayPal({
      'GET /v1/payments/payouts/{id}': () => ({ json: { batch_header: { payout_batch_id: 'B', batch_status: 'SUCCESS' }, items: [item] } }),
      'POST /v1/payments/payouts-item/{id}/cancel': () => ({ json: { transaction_status: 'RETURNED' } }),
    });
    await pp.transitionTransfer('B', 'FAILED');
    expect(sent.at(-1)!.path).toBe('/v1/payments/payouts-item/ITEM1/cancel');
    item = { payout_item_id: 'ITEM1', transaction_status: 'SUCCESS' };
    await expect(pp.transitionTransfer('B', 'FAILED')).rejects.toThrow(/only an unclaimed payout/);
  });

  it('refuses FX: the PayPal books run in one currency', async () => {
    const { pp } = mockPayPal({});
    await expect(pp.quote()).rejects.toThrow(/no conversion API/);
  });

  it('retries once with a fresh token on a 401', async () => {
    let n = 0;
    const { pp, sent } = mockPayPal({ 'GET /v1/reporting/balances': () => (++n === 1 ? { status: 401, json: { name: 'AUTH' } } : { json: { balances: [] } }) });
    await pp.balances();
    expect(sent.filter((s) => s.path === '/v1/oauth2/token')).toHaveLength(2);
  });
});
