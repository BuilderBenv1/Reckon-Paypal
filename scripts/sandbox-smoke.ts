// Checks every Airwallex call Reckon makes against YOUR sandbox, one step at a time.
// Run once after adding keys to .env:   npm run sandbox:smoke
// Each step prints OK or the exact API error, and carries on, so any field name the
// sandbox rejects shows up on its own line. Fixes go in src/airwallex/rest.ts.
import { AirwallexRest } from '../src/airwallex/rest.js';
import { payees } from '../src/domain/payees.js';

try {
  process.loadEnvFile('.env');
} catch {
  console.error('No .env found. Copy .env.example to .env and add your sandbox keys.');
  process.exit(1);
}

const awx = AirwallexRest.fromEnv();
const results: [string, 'OK' | 'FAIL', string][] = [];

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const out = await fn();
    results.push([name, 'OK', JSON.stringify(out)?.slice(0, 160) ?? '']);
    console.log(`OK    ${name}`);
    return out;
  } catch (err) {
    results.push([name, 'FAIL', (err as Error).message]);
    console.log(`FAIL  ${name}\n      ${(err as Error).message}`);
    return undefined;
  }
}

await step('login + balances', () => awx.balances());
await step('find or create a USD Global Account', async () => (await awx.globalAccount('USD')) ?? awx.createGlobalAccount('USD'));
await step('simulate USD deposit of 25,000', () => awx.deposit(25000, 'USD', 'Seed funding'));
await step('balances after deposit', () => awx.balances());
const q = await step('FX quote USD -> EUR 100', () => awx.quote('USD', 'EUR', 100));
if (q) await step('FX conversion (books the quote)', () => awx.convert({ requestId: crypto.randomUUID(), quote: q }));
const ben = await step('create US LOCAL beneficiary', () => awx.ensureBeneficiary(payees['Brightline Electrical Inc']!));
await step('create GB LOCAL beneficiary', () => awx.ensureBeneficiary(payees['Pennine Joinery Supplies Ltd']!));
await step('create DE SWIFT beneficiary', () => awx.ensureBeneficiary(payees['Rheinfracht Logistik GmbH']!));
const requestId = crypto.randomUUID();
const t = ben ? await step('transfer USD 10 LOCAL', () => awx.createTransfer({ requestId, beneficiaryId: ben, amount: 10, currency: 'USD', method: 'LOCAL', reference: 'RECKON SMOKE', reason: 'construction' })) : undefined;
if (t) {
  await step('find transfer by request id', () => awx.findTransferByRequestId(requestId));
  await step('simulate SENT', () => awx.transitionTransfer(t.id, 'SENT'));
  await step('simulate FAILED with failure type', () => awx.transitionTransfer(t.id, 'FAILED', 'ACCOUNT_CLOSED'));
  await step('read transfer (expect CANCELLED + failure_type)', () => awx.getTransfer(t.id));
}
const link = await step('create payment link USD 50', () => awx.createPaymentLink({ title: 'Reckon smoke test', amount: 50, currency: 'USD', reference: 'SMOKE' }));
if (link) {
  await step('read payment link', () => awx.getPaymentLink(link.id));
  console.log(`\nPay it with test card 4035501000000008 (any future expiry, any CVC): ${link.url}`);
}

const failed = results.filter((r) => r[1] === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} steps passed.`);
if (failed.length) process.exitCode = 1;
