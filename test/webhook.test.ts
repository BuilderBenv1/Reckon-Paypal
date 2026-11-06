import { describe, expect, it } from 'vitest';
import { seedRates } from '../src/domain/seed.js';
import { FakeBank } from '../src/bank/fake.js';
import { Session } from '../src/demo/session.js';
import { MemoryRunStore } from '../src/store/runs.js';
import { withRun } from '../src/store/withRun.js';
import { handleEvent, invoiceIdOf, payoutBatchOf, webhookHeaders } from '../src/webhooks/paypal.js';

describe('webhook headers', () => {
  const base: Record<string, string> = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42',
    'paypal-transmission-id': 't1',
    'paypal-transmission-sig': 'sig',
    'paypal-transmission-time': '2026-11-06T10:00:00Z',
  };
  const get = (h: Record<string, string>) => (n: string) => h[n] ?? null;

  it('reads all five signature headers', () => {
    expect(webhookHeaders(get(base))).toMatchObject({ authAlgo: 'SHA256withRSA', transmissionId: 't1' });
  });

  it('rejects a missing header or a cert served from outside paypal.com', () => {
    const { 'paypal-transmission-sig': _s, ...noSig } = base;
    expect(webhookHeaders(get(noSig))).toBeNull();
    expect(webhookHeaders(get({ ...base, 'paypal-cert-url': 'https://evil.example/paypal.com/cert' }))).toBeNull();
    expect(webhookHeaders(get({ ...base, 'paypal-cert-url': 'https://paypal.com.evil.example/cert' }))).toBeNull();
  });

  it('finds the invoice and payout batch an event is about', () => {
    expect(invoiceIdOf({ id: 'e', event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: 'INV2-A' } } })).toBe('INV2-A');
    expect(invoiceIdOf({ id: 'e', event_type: 'INVOICING.INVOICE.PAID', resource: { id: 'INV2-B' } })).toBe('INV2-B');
    expect(payoutBatchOf({ id: 'e', event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', resource: { payout_batch_id: 'B1' } })).toBe('B1');
    expect(payoutBatchOf({ id: 'e', event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS', resource: { batch_header: { payout_batch_id: 'B2' } } })).toBe('B2');
  });
});

describe('webhook handling on live runs', () => {
  async function liveRunWithLink() {
    const inner = new FakeBank({ USD: 1e7, EUR: 1e7, GBP: 1e7 }, seedRates);
    const deps = { claude: false, live: () => inner };
    const store = new MemoryRunStore(false);
    const s = await Session.create('live', deps);
    let run = await store.create('live', s.snapshot(), s.refs());
    run = (await withRun(store, run.id, (x) => x.act({ type: 'delay_email' }), deps)).run;
    run = (await withRun(store, run.id, (x) => x.act({ type: 'run' }), deps)).run;
    return { inner, deps, store, run };
  }

  it('a paid invoice makes the agent replan and execute on its own', async () => {
    const { inner, deps, store, run } = await liveRunWithLink();
    const linkId = run.data.reckon.links.find(([r]) => r === 'REC-121-INV')![1];
    await inner.payLink(linkId);
    const handled = await handleEvent(store, { id: 'evt_9', event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: linkId } } }, deps);
    expect(handled).toEqual([run.id]);
    const after = (await store.get(run.id))!;
    expect(after.data.reckon.state.earlyPayLinks['REC-121-INV']).toBe('paid');
    expect(after.data.done).toContain('customer_pays');
  });

  it('a transfer event updates that transfer in the ledger', async () => {
    const { inner, deps, store, run } = await liveRunWithLink();
    const attempt = run.data.reckon.ledger.attempts.find((a) => a.payableId === 'PAY-109-SUB')!;
    await inner.transitionTransfer(attempt.transferId!, 'SENT');
    await inner.transitionTransfer(attempt.transferId!, 'PAID');
    const handled = await handleEvent(store, { id: 'evt_10', event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', resource: { payout_batch_id: attempt.transferId! } }, deps);
    expect(handled).toEqual([run.id]);
    const after = (await store.get(run.id))!;
    expect(after.data.reckon.ledger.attempts.find((a) => a.transferId === attempt.transferId)?.status).toBe('PAID');
  });

  it('ignores events for transfers no run owns', async () => {
    const { deps, store } = await liveRunWithLink();
    expect(await handleEvent(store, { id: 'evt_11', event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', resource: { payout_batch_id: 'tfr_unknown' } }, deps)).toEqual([]);
  });
});
