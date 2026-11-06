import { describe, expect, it } from 'vitest';
import { seedRates } from '../src/domain/seed.js';
import { FakeAirwallex } from '../src/airwallex/fake.js';
import { Session } from '../src/demo/session.js';
import { MemoryRunStore } from '../src/store/runs.js';
import { withRun } from '../src/store/withRun.js';
import { handleEvent, signatureFor, TOLERANCE_MS, verifySignature } from '../src/webhooks/airwallex.js';

const secret = 'whsec_test';
const body = '{"id":"evt_1","name":"payment_intent.succeeded","data":{"object":{"id":"int_1"}}}';

describe('webhook signature', () => {
  const now = 1_800_000_000_000;
  const ts = String(now);

  it('accepts a correct signature over timestamp + raw body', () => {
    expect(verifySignature(body, ts, signatureFor(secret, ts, body), secret, now)).toEqual({ ok: true });
  });

  it('rejects a body changed by re-serialising', () => {
    const sig = signatureFor(secret, ts, body);
    expect(verifySignature(JSON.stringify(JSON.parse(body), null, 1), ts, sig, secret, now)).toMatchObject({ ok: false, reason: 'signature mismatch' });
  });

  it('rejects the wrong secret, a stale timestamp and missing headers', () => {
    expect(verifySignature(body, ts, signatureFor('other', ts, body), secret, now).ok).toBe(false);
    const old = String(now - TOLERANCE_MS - 1);
    expect(verifySignature(body, old, signatureFor(secret, old, body), secret, now)).toMatchObject({ reason: 'timestamp outside tolerance' });
    expect(verifySignature(body, null, null, secret, now)).toMatchObject({ reason: 'missing x-timestamp or x-signature' });
  });
});

describe('webhook handling on live runs', () => {
  async function liveRunWithLink() {
    const inner = new FakeAirwallex({ USD: 1e7, EUR: 1e7, GBP: 1e7 }, seedRates);
    const deps = { claude: false, live: () => inner };
    const store = new MemoryRunStore(false);
    const s = await Session.create('live', deps);
    let run = await store.create('live', s.snapshot(), s.refs());
    run = (await withRun(store, run.id, (x) => x.act({ type: 'delay_email' }), deps)).run;
    run = (await withRun(store, run.id, (x) => x.act({ type: 'run' }), deps)).run;
    return { inner, deps, store, run };
  }

  it('a paid link makes the agent replan and execute on its own', async () => {
    const { inner, deps, store, run } = await liveRunWithLink();
    const linkId = run.data.reckon.links.find(([r]) => r === 'REC-121-INV')![1];
    await inner.payLink(linkId);
    const handled = await handleEvent(store, { id: 'evt_9', name: 'payment_intent.succeeded' }, deps);
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
    const handled = await handleEvent(store, { id: 'evt_10', name: 'payout.transfer.paid', data: { object: { id: attempt.transferId! } } }, deps);
    expect(handled).toEqual([run.id]);
    const after = (await store.get(run.id))!;
    expect(after.data.reckon.ledger.attempts.find((a) => a.transferId === attempt.transferId)?.status).toBe('PAID');
  });

  it('ignores events for transfers no run owns', async () => {
    const { deps, store } = await liveRunWithLink();
    expect(await handleEvent(store, { id: 'evt_11', name: 'payout.transfer.paid', data: { object: { id: 'tfr_unknown' } } }, deps)).toEqual([]);
  });
});
