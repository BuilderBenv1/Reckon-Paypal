// Checks every PayPal call Reckon makes against your sandbox and prints PayPal's exact error for any
// that fail. Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env. Fixes go in src/paypal/rest.ts.
import { PayPalRest } from '../src/paypal/rest.js';
import { runSmoke } from '../src/paypal/smoke.js';

try {
  process.loadEnvFile('.env');
} catch {
  // no .env: use the environment as it is
}

const r = await runSmoke(PayPalRest.fromEnv());
for (const s of r.steps) console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name}\n      ${s.detail}`);
console.log(`\n${r.passed}/${r.total} passed. Calls: ${r.calls.join(', ')}`);
if (r.payerLink) console.log(`\nTo check a paid invoice end to end, open ${r.payerLink} signed in as your sandbox personal account.`);
process.exit(r.passed === r.total ? 0 : 1);
