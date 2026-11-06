// The whole demo story against YOUR Airwallex sandbox.
//   npm run demo:live
//
// Every conversion, beneficiary, transfer, simulated failure and payment link is a real
// sandbox call. The agent plans from the business's story-sized balances (an operating
// envelope), not the millions a new sandbox starts with. Midway, the customer's early-pay
// link opens in your browser: pay it with test card 4035501000000008, any future expiry
// and any CVC, and the story carries on by itself.
import { exec } from 'node:child_process';
import { seedBalances } from '../src/domain/seed.js';
import { AirwallexRest } from '../src/airwallex/rest.js';
import { OperatingEnvelope } from '../src/airwallex/envelope.js';
import { ClaudeReader, FixtureReader } from '../src/agent/reader.js';
import { runStory } from './story.js';

try {
  process.loadEnvFile('.env');
} catch {
  console.error('No .env found. Copy .env.example to .env and add your sandbox keys.');
  process.exit(1);
}

const rest = AirwallexRest.fromEnv();
const awx = new OperatingEnvelope(rest, seedBalances);
const reader = process.env.ANTHROPIC_API_KEY ? new ClaudeReader() : new FixtureReader();
console.log(`Email reader: ${process.env.ANTHROPIC_API_KEY ? 'Claude' : 'fixture (set ANTHROPIC_API_KEY to use Claude)'}`);

const openInBrowser = (url: string) => {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => undefined);
};

async function waitForPayment(linkId: string, url: string) {
  console.log(`\n  Customer's payment link: ${url}`);
  console.log('  Opening it in your browser. Pay with test card 4035501000000008, any future expiry, any CVC.');
  openInBrowser(url);
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const link = await rest.getPaymentLink(linkId);
    if (link.status === 'PAID') {
      console.log('  Payment received.');
      return;
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('Gave up waiting 15 minutes for the payment link to be paid.');
}

await runStory({
  awx,
  reader,
  payLink: waitForPayment,
  newId: () => crypto.randomUUID(), // real request ids: the sandbox rejects reuse within 7 days
  clock: () => new Date().toISOString(),
  outDir: 'out/live',
});
