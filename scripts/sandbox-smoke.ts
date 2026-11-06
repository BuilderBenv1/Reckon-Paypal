// Checks every PayPal call Reckon makes against your sandbox, one step at a time, and prints the
// exact API error for any that fail. Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.
// Fixes go in src/paypal/rest.ts. Moves only test money: one $1 payout and one $1 invoice.
import { PayPalRest, PayPalError } from '../src/paypal/rest.js';
import { payees } from '../src/domain/payees.js';

try {
  process.loadEnvFile('.env');
} catch {
  // no .env: use the environment as it is
}

const pp = PayPalRest.fromEnv();
const results: [string, boolean, string][] = [];

async function step<T>(name: string, fn: () => Promise<T>, show: (v: T) => string = (v) => JSON.stringify(v).slice(0, 160)): Promise<T | undefined> {
  try {
    const v = await fn();
    results.push([name, true, show(v)]);
    return v;
  } catch (err) {
    const e = err as PayPalError;
    results.push([name, false, `${e.message}${e.debugId ? ` (debug_id ${e.debugId})` : ''}`]);
    return undefined;
  }
}

const requestId = crypto.randomUUID();
await step('balances (Reporting API: needs Transaction Search on the app)', () => pp.balances());
const payee = await step('payee', () => pp.ensureBeneficiary(payees['Planwise Software Inc']!), (v) => v);
const payout = payee
  ? await step('create payout ($1)', () =>
      pp.createTransfer({ requestId, beneficiaryId: payee, amount: 1, currency: 'USD', method: 'LOCAL', reference: 'SMOKE-1', reason: 'technical_services' }),
    )
  : undefined;
if (payout) {
  await step('read payout', () => pp.getTransfer(payout.id), (t) => `${t.id} ${t.status}${t.failureType ? ` ${t.failureType}` : ''}`);
  await step('find payout by request id', () => pp.findTransferByRequestId(requestId), (t) => (t ? `${t.id} ${t.status}` : 'not found'));
  await step(
    'same request id again is refused (never pay twice)',
    async () => {
      try {
        await pp.createTransfer({ requestId, beneficiaryId: payee!, amount: 1, currency: 'USD', method: 'LOCAL', reference: 'SMOKE-1', reason: 'technical_services' });
      } catch (err) {
        return `refused: ${(err as Error).message.slice(0, 100)}`;
      }
      throw new Error('PayPal accepted a repeated sender_batch_id');
    },
    (v) => v,
  );
}
const link = await step('create and send invoice ($1)', () => pp.createPaymentLink({ title: 'Smoke test', amount: 1, currency: 'USD', reference: 'SMOKE-INV' }), (l) => `${l.id} ${l.url}`);
if (link) {
  await step('read invoice', () => pp.getPaymentLink(link.id), (l) => `${l.id} ${l.status} ${l.amount} ${l.currency}`);
  await step('remind (PayPal emails the customer)', () => pp.notifyShopper(link.id, 'smoke-buyer@example.com'), () => 'sent');
}

for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
const passed = results.filter((r) => r[1]).length;
console.log(`\n${passed}/${results.length} passed. Calls: ${pp.calls.join(', ')}`);
if (link) console.log(`\nTo check a paid invoice end to end, open ${link.url} signed in as your sandbox personal account.`);
process.exit(passed === results.length ? 0 : 1);
