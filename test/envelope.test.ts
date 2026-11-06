import { describe, expect, it } from 'vitest';
import { defaultPolicy, seedBalances, seedBook, seedRates } from '../src/domain/seed.js';
import { FakeAirwallex } from '../src/airwallex/fake.js';
import { OperatingEnvelope } from '../src/airwallex/envelope.js';
import type { AirwallexPort, SandboxSimulator } from '../src/airwallex/port.js';
import { FixtureReader } from '../src/agent/reader.js';
import { Reckon } from '../src/agent/reckon.js';
import { initialState } from '../src/policy/state.js';

const MILLIONS = { USD: 10_000_000, EUR: 10_000_000, GBP: 10_000_000 };

async function story(awx: AirwallexPort & SandboxSimulator) {
  let t = 0;
  let n = 0;
  const reckon = new Reckon(
    initialState(structuredClone(seedBook), { ...seedBalances }, seedRates),
    defaultPolicy,
    awx,
    new FixtureReader(),
    () => `2026-11-02T09:${String(++t).padStart(2, '0')}:00Z`,
    () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  );
  await reckon.refreshBalances();
  await reckon.ingestEmail({ id: 'EM-01', from: 'x', subject: 'x', body: 'x' });
  const executed: string[] = [];
  executed.push(...(await reckon.run()).executed);
  reckon.approve('convert:EUR', 'MD');
  executed.push(...(await reckon.run()).executed);
  await awx.payLink(reckon.links.get('REC-121-INV')!);
  await reckon.checkLinks();
  await reckon.ingestEmail({ id: 'EM-02', from: 'x', subject: 'x', body: 'x' });
  executed.push(...(await reckon.run()).executed);
  return { executed, balances: await awx.balances(), final: reckon.plan().plan };
}

describe('operating envelope over a pre-funded sandbox', () => {
  it('a sandbox holding millions would otherwise never show a cash gap', async () => {
    const raw = new FakeAirwallex(MILLIONS, seedRates);
    const reckon = new Reckon(initialState(seedBook, seedBalances, seedRates), defaultPolicy, raw, new FixtureReader(), () => 'now');
    await reckon.refreshBalances();
    await reckon.ingestEmail({ id: 'EM-01', from: 'x', subject: 'x', body: 'x' });
    expect(reckon.plan().plan.summary.gapUSD).toBeLessThan(0);
  });

  it('gives the same decisions and balances as a story-sized wallet', async () => {
    const plain = await story(new FakeAirwallex({ ...seedBalances }, seedRates));
    const enveloped = await story(new OperatingEnvelope(new FakeAirwallex(MILLIONS, seedRates), seedBalances));
    expect(enveloped.executed).toEqual(plain.executed);
    expect(enveloped.balances).toEqual(plain.balances);
    expect(enveloped.final.summary).toEqual(plain.final.summary);
  });

  it('refunds a cancelled transfer to the operating balance exactly once', async () => {
    const inner = new FakeAirwallex(MILLIONS, seedRates);
    const env = new OperatingEnvelope(inner, { USD: 5000, EUR: 0, GBP: 0 });
    const t = await env.createTransfer({ requestId: 'r-1', beneficiaryId: 'b', amount: 1000, currency: 'USD', method: 'LOCAL', reference: 'x', reason: 'construction' });
    expect((await env.balances()).USD).toBe(4000);
    await env.transitionTransfer(t.id, 'SENT');
    await env.transitionTransfer(t.id, 'FAILED', 'ACCOUNT_CLOSED');
    await env.getTransfer(t.id);
    await env.getTransfer(t.id);
    expect((await env.balances()).USD).toBe(5000);
  });

  it('refuses to spend more than the operating balance even though the sandbox could', async () => {
    const env = new OperatingEnvelope(new FakeAirwallex(MILLIONS, seedRates), { USD: 100, EUR: 0, GBP: 0 });
    await expect(
      env.createTransfer({ requestId: 'r-2', beneficiaryId: 'b', amount: 500, currency: 'USD', method: 'LOCAL', reference: 'x', reason: 'construction' }),
    ).rejects.toThrow(/operating balance/);
  });
});
